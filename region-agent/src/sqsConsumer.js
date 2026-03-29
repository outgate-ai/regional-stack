/**
 * SQS long-poll consumer.
 * Receives messages from the region's FIFO queue and routes them
 * to the appropriate command handler.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { routeCommand } from './commandRouter.js';
import { sendCallback } from './webhookSender.js';

let _running = false;
let _client = null;
let _pollTimer = null;

/**
 * Start the SQS polling loop.
 * @param {object} config - Application configuration
 */
export function startPolling(config) {
  _running = true;
  poll(config);
}

/**
 * Reset the SQS client so it picks up new credentials on next poll.
 */
export function resetSqsClient() {
  _client = null;
}

/**
 * Stop the SQS polling loop.
 */
export function stopPolling() {
  _running = false;
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

async function poll(config) {
  if (!_running) return;

  // Lazy client init (supports credential rotation via resetSqsClient)
  if (!_client) {
    _client = new SQSClient({ region: config.awsRegion });
  }

  let hadMessages = false;

  try {
    const response = await _client.send(
      new ReceiveMessageCommand({
        QueueUrl: config.sqsQueueUrl,
        MaxNumberOfMessages: config.sqsMaxMessages,
        WaitTimeSeconds: config.sqsWaitTimeSeconds,
        MessageAttributeNames: ['All'],
      })
    );

    const messages = response.Messages || [];
    hadMessages = messages.length > 0;

    if (hadMessages) {
      console.log(`[sqs-consumer] Received ${messages.length} message(s)`);
    }

    for (const message of messages) {
      await processMessage(config, message);
    }
  } catch (err) {
    console.error('[sqs-consumer] Poll error:', err.message);
  }

  // Poll again immediately if we got messages (more may be waiting),
  // otherwise start the next long-poll with no gap since WaitTimeSeconds
  // already provides the blocking wait.
  if (_running) {
    if (hadMessages) {
      setImmediate(() => poll(config));
    } else {
      // No delay needed — the next long-poll will block for up to 20s on SQS side.
      // A small delay prevents a tight loop only on errors.
      _pollTimer = setTimeout(() => poll(config), config.sqsErrorPollDelayMs);
    }
  }
}

async function processMessage(config, message) {
  let command;
  try {
    command = JSON.parse(message.Body);
    console.log(`[sqs-consumer] Processing command: ${command.type} (${command.commandId})`);

    const result = await routeCommand(command);

    // Send callback to the global BFF
    await sendCallback(config, {
      commandId: command.commandId,
      regionId: config.regionId,
      organizationId: command.organizationId,
      type: command.type,
      status: result.status === 'SUCCESS' ? 'success' : 'failed',
      result: result.result || {},
    });

    // Delete message from queue on success
    await _client.send(
      new DeleteMessageCommand({
        QueueUrl: config.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );

    console.log(`[sqs-consumer] Command ${command.commandId} completed: ${result.status}`);
  } catch (err) {
    const cmdId = command?.commandId || 'unknown';
    console.error(`[sqs-consumer] Error processing command ${cmdId}:`, err.message);
    // Do NOT delete message - it will be retried via visibility timeout
  }
}
