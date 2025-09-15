import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from './logger.js';
import { createMcpServerInstance, initializeServerState } from './mcp-server-core.js';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(',') || ['127.0.0.1', 'localhost'];
const ENABLE_DNS_REBINDING_PROTECTION = process.env.ENABLE_DNS_REBINDING_PROTECTION === 'true';

/**
 * Create a full MCP server instance with all 21 tools for HTTP transport
 */
async function createFullMcpServer(): Promise<McpServer> {
  // Initialize server state first
  await initializeServerState();
  
  // Create the full server instance with all tools
  return await createMcpServerInstance();
}

export async function startHttpServer(): Promise<void> {
  log('Starting FileScopeMCP HTTP server...');
  
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Configure CORS
  app.use(cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(','),
    exposedHeaders: ['Mcp-Session-Id'],
    allowedHeaders: ['Content-Type', 'mcp-session-id'],
    credentials: true
  }));

  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Health check endpoint
  app.get('/health', (req: express.Request, res: express.Response) => {
    res.json({ 
      status: 'healthy', 
      service: 'FileScopeMCP',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      transport: 'http'
    });
  });

  // Handle POST requests for client-to-server communication
  app.post('/mcp', async (req: express.Request, res: express.Response) => {
    try {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
        log(`Reusing existing transport for session: ${sessionId}`);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        log('Creating new transport for initialization request');
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            // Store the transport by session ID
            transports[newSessionId] = transport;
            log(`Session initialized: ${newSessionId}`);
          },
          // DNS rebinding protection
          enableDnsRebindingProtection: ENABLE_DNS_REBINDING_PROTECTION,
          allowedHosts: ENABLE_DNS_REBINDING_PROTECTION ? ALLOWED_HOSTS : undefined,
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            log(`Cleaning up session: ${transport.sessionId}`);
            delete transports[transport.sessionId];
          }
        };

        // Create and connect the MCP server
        const server = await createFullMcpServer();
        await server.connect(transport);
        log('MCP server connected to new transport');
      } else {
        // Invalid request
        log('Invalid request: No valid session ID provided');
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log('Error handling MCP request: ' + error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      log(`Invalid or missing session ID: ${sessionId}`);
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete('/mcp', handleSessionRequest);

  // Error handling middleware
  app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    log('Express error: ' + error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  });

  // Start the server
  const server = app.listen(PORT, () => {
    log(`🚀 FileScopeMCP HTTP server listening on port ${PORT}`);
    log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
    log(`🏥 Health check: http://localhost:${PORT}/health`);
    log(`🔒 DNS rebinding protection: ${ENABLE_DNS_REBINDING_PROTECTION ? 'enabled' : 'disabled'}`);
    log(`🌐 CORS origin: ${CORS_ORIGIN}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down gracefully');
    server.close(() => {
      log('HTTP server closed');
      // Clean up all transports
      Object.values(transports).forEach(transport => {
        transport.close?.();
      });
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    log('SIGINT received, shutting down gracefully');
    server.close(() => {
      log('HTTP server closed');
      // Clean up all transports
      Object.values(transports).forEach(transport => {
        transport.close?.();
      });
      process.exit(0);
    });
  });
}
