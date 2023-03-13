'use strict';

const async = require('async');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

let Logger;
let originalOptions = {};
let ec2Client = null;

/**
 * This captures the deprecation warning for Node 12 and prevents it from being reported as an error by
 * the integration framework.  Instead we just log it as a warning.
 */
const origWarning = process.emitWarning;
process.emitWarning = function (...args) {
  if (Array.isArray(args) && args.length > 0 && args[0].startsWith('The AWS SDK for JavaScript (v3) will')) {
    // Log the deprecation in our integration logs but don't bubble it up on stderr
    Logger.warn({ args }, 'Node12 Deprecation Warning');
  } else {
    // pass any other warnings through normally
    return origWarning.apply(process, args);
  }
};

function startup(logger) {
  Logger = logger;
}

/**
 * Used to escape single quotes in entities and remove any newlines
 * @param entityValue
 * @returns {*}
 */
function escapeEntityValue(entityValue) {
  const escapedValue = entityValue
    .replace(/(\r\n|\n|\r)/gm, '')
    .replace(/\\/, '\\\\')
    .replace(/'/g, '\\');
  Logger.trace({ entityValue, escapedValue }, 'Escaped Entity Value');
  return escapedValue;
}

function optionsHaveChanged(options) {
  if (
    originalOptions.region !== options.region ||
    originalOptions.accessKeyId !== options.accessKeyId ||
    originalOptions.secretAccessKey !== options.secretAccessKey
  ) {
    originalOptions = options;
    return true;
  }
  return false;
}

function errorToPojo(err, detail) {
  return err instanceof Error
    ? {
        ...err,
        name: err.name,
        message: err.message,
        stack: err.stack,
        detail: err.message ? err.message : err.detail ? err.detail : 'Unexpected error encountered'
      }
    : err;
}

/**
 * Filter names that filter on an IP or domain value.
 *
 * dns-name - The public DNS name of the instance.
 *    Example: ec2-52-201-219-48.compute-1.amazonaws.com
 * ip-address - The public IPv4 address of the instance.
 *    Example: 172.31.62.233
 * network-interface.association.public-ip - The address of the Elastic IP address (IPv4) bound to the network interface.
 * network-interface.addresses.private-ip-address - The private IPv4 address associated with the network interface.
 * network-interface.ipv6-addresses.ipv6-address - The IPv6 address associated with the network interface.
 * network-interface.private-dns-name - The private DNS name of the network interface.
 * private-dns-name - The private IPv4 DNS name of the instance.
 *    Example: ip-172-31-62-233.ec2.internal
 * private-ip-address - The private IPv4 address of the instance.
 *
 * Multiple filter objects can be added to the filter and they are "AND'd" together.  Multiple `Values` within a single
 * filter object are "OR'd" together.  There is no way to search multiple filter names using an "OR".
 *
 * @param entity
 */
function createFilter(entity) {
  if (entity.isIPv4 && entity.isPrivateIP) {
    return [
      {
        Name: 'private-ip-address',
        Values: [entity.value]
      }
    ];
  }

  if (entity.isIPv6 && entity.isPrivateIP) {
    return [
      {
        Name: 'network-interface.addresses.private-ip-address',
        Values: [entity.value]
      }
    ];
  }

  if (entity.isIPv4 && !entity.isPrivateIP) {
    return [
      {
        Name: 'ip-address',
        Values: [entity.value]
      }
    ];
  }

  if (entity.isIPv6 && !entity.isPrivateIP) {
    return [
      {
        Name: 'network-interface.ipv6-addresses.ipv6-address',
        Values: [entity.value]
      }
    ];
  }

  // ensure privateIpDnsName type is always run as a `private-dns-name` search even
  // if the regex is modified to include a valid TLD which cause the `isDomain` flag
  // to be true (INT-922)
  if (entity.isDomain && !entity.types.includes('custom.privateIpDnsName')) {
    return [
      {
        Name: 'dns-name',
        Values: [entity.value]
      }
    ];
  }

  if (entity.types.includes('custom.privateIpDnsName')) {
    return [
      {
        Name: 'private-dns-name',
        Values: [entity.value]
      }
    ];
  }

  if (entity.types.includes('custom.instanceId')) {
    return [
      {
        Name: 'instance-id',
        Values: [entity.value]
      }
    ];
  }

  throw new Error(`Unsupported entity type ${entity.types.join(',')}`)
}

function createSummaryTags(results) {
  const tags = [];
  let numInstances = 0;
  if (Array.isArray(results.Reservations)) {
    results.Reservations.forEach((reservation) => {
      if (Array.isArray(reservation.Instances)) {
        numInstances += reservation.Instances.length;
        reservation.Instances.forEach((instance) => {
          const name = instance.Tags.find((tag) => tag.Key === 'Name');
          instance.Name = name.Value;
          if (name) {
            tags.push(name.Value);
          }
        });
      }
    });
  }

  // No tags so just put a number of instances
  if(tags.length === 0){
    tags.push(`${numInstances} instance${numInstances > 1 ? 's' : ''}`);
  }

  return tags;
}

async function doLookup(entities, options, cb) {
  let lookupResults;

  Logger.trace({entities}, 'doLookup');

  if (optionsHaveChanged(options) || ec2Client === null) {
    const clientOptions = {
      region: options.region.value
    };

    if (options.accessKeyId.length > 0 || options.secretAccessKey.length > 0) {
      clientOptions.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      };
    }

    Logger.trace({ clientOptions }, 'Creating new EC2 client');
    ec2Client = new EC2Client(clientOptions);
  }

  const searchTasks = entities.map((entity) => {
    return async () => {
      const query = new DescribeInstancesCommand({
        Filters: createFilter(entity)
      });
      Logger.trace({ query }, 'EC2 Search Query');
      const result = await ec2Client.send(query);
      Logger.trace({ result }, 'Raw Query Result');
      if (Array.isArray(result.Reservations) && result.Reservations.length === 0) {
        return {
          entity,
          data: null
        };
      } else {
        Logger.trace({ result }, 'JSON Results');
        return {
          entity,
          data: {
            summary: createSummaryTags(result),
            details: result
          }
        };
      }
    };
  });

  try {
    lookupResults = await async.parallelLimit(searchTasks, 10);
  } catch (lookupError) {
    Logger.error(lookupError, 'doLookup error');
    return cb(errorToPojo(lookupError, 'Error running EC2 search'));
  }

  Logger.trace({ lookupResults }, 'lookup results');

  cb(null, lookupResults);
}

function validateOptions(userOptions, cb) {
  let errors = [];
  if (
    typeof userOptions.accessKeyId.value !== 'string' ||
    (typeof userOptions.accessKeyId.value === 'string' && userOptions.accessKeyId.value.length === 0)
  ) {
    errors.push({
      key: 'accessKeyId',
      message: 'You must provide an AWS Access Key Id'
    });
  }

  if (
    typeof userOptions.secretAccessKey.value !== 'string' ||
    (typeof userOptions.secretAccessKey.value === 'string' && userOptions.secretAccessKey.value.length === 0)
  ) {
    errors.push({
      key: 'secretAccessKey',
      message: 'You must provide an AWS Secret Access Key'
    });
  }

  cb(null, errors);
}

module.exports = {
  doLookup,
  startup,
  validateOptions
};
