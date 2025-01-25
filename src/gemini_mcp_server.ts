import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { config } from 'dotenv';
import { z } from "zod";

// Immediately send the startup message before anything else can write to stdout
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  method: "startup",
  params: {
    transport: "stdio"
  }
}) + '\n');

// Redirect stdout to stderr for everything else
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk: any, ...args: any[]) => {
  return process.stderr.write(chunk, ...args);
};

// Redirect console methods to stderr
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
consoleMethods.forEach(method => {
  (console as any)[method] = (...args: any[]) => process.stderr.write(`[${method}] ` + args.join(' ') + '\n');
});

// Suppress npm and Node.js startup messages
process.env.NODE_ENV = 'production';
process.env.NO_UPDATE_NOTIFIER = '1';
process.env.SUPPRESS_NO_CONFIG_WARNING = 'true';
process.env.npm_config_loglevel = 'silent';

// Load environment variables
config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

// Define tool schemas
const generateTextSchema = z.object({
  prompt: z.string().min(1),
  temperature: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().min(1).max(8192).optional(),
  topK: z.number().min(1).max(40).optional(),
  topP: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
});

type GenerateTextParams = z.infer<typeof generateTextSchema>;

class GeminiMCPServer {
  private model: GenerativeModel;
  private server: McpServer;
  private transport: StdioServerTransport;
  private chat: any; // Store chat session

  constructor() {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    this.model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    this.chat = this.model.startChat();
    
    this.server = new McpServer({
      name: "gemini",
      version: "1.0.0",
      capabilities: {
        tools: {
          generate_text: {
            description: "Generate text using Gemini Pro model",
            streaming: true
          }
        }
      }
    });

    this.transport = new StdioServerTransport();
  }

  private async generateText(params: GenerateTextParams) {
    try {
      const { prompt, temperature = 0.7, maxOutputTokens = 8192, topK, topP, stream = false } = params;
      const generationConfig = {
        temperature,
        maxOutputTokens,
        topK,
        topP,
      };

      console.log('Sending message to Gemini:', prompt);

      if (stream) {
        const result = await this.chat.sendMessageStream(prompt);
        let fullText = '';
        
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          fullText += chunkText;
          
          // Send intermediate chunk as progress event
          // Note: Progress events are not yet supported in MCP SDK
          // this.server.emit("generate_text/progress", {
          //   content: [{
          //     type: "text",
          //     text: chunkText
          //   }]
          // });
        }

        console.log('Received streamed response from Gemini:', fullText);

        return {
          content: [{
            type: "text" as const,
            text: fullText
          }]
        };
      } else {
        const result = await this.chat.sendMessage(prompt);
        const response = result.response.text();
        
        console.log('Received response from Gemini:', response);

        return {
          content: [{
            type: "text" as const,
            text: response
          }]
        };
      }
    } catch (err) {
      console.error('Error generating content:', err);
      return {
        content: [{
          type: "text" as const,
          text: err instanceof Error ? err.message : 'Internal error'
        }],
        isError: true
      };
    }
  }

  async start() {
    try {
      console.info('Initializing Gemini MCP server...');

      // Register generate_text tool
      this.server.tool(
        "generate_text",
        generateTextSchema.shape,
        async (args: GenerateTextParams) => this.generateText(args)
      );

      // Restore stdout for MCP communication
      process.stdout.write = originalStdoutWrite;
      
      // Connect using stdio transport
      await this.server.connect(this.transport);
      console.info('Server started successfully and waiting for messages...');
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  async stop() {
    try {
      // Note: Disconnect is not yet supported in MCP SDK
      // await this.server.disconnect();
      console.info('Server stopped successfully');
    } catch (error) {
      console.error('Error stopping server:', error);
      process.exit(1);
    }
  }
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.info('Server shutting down');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Start the server
const server = new GeminiMCPServer();
server.start().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 