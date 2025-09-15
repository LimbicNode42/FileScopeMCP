#!/usr/bin/env node

/**
 * Entry point for FileScopeMCP HTTP server
 * 
 * Usage:
 *   npm run start:http
 *   node dist/start-http.js
 */

import { startHttpServer } from './http-server.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  try {
    await startHttpServer();
  } catch (error) {
    log('Failed to start HTTP server: ' + error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled rejection at: ${promise}, reason: ${reason}`);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error}`);
  process.exit(1);
});

// Start the server
main().catch((error) => {
  log('Fatal error: ' + error);
  process.exit(1);
});
