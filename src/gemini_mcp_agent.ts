import {
  GenerativeModel,
  GoogleGenerativeAI,
  GenerateContentResult,
  Content,
  Part,
  GenerationConfig,
} from '@google/generative-ai';
import { config } from 'dotenv';
import { MCPClientImpl, MCPServerParameters } from './mcp_client';
import { createInterface } from 'readline';
import * as fs from 'fs';
import * as path from 'path';

config(); // Load environment variables

// Use Gemini 1.5 Pro for enhanced capabilities
const MODEL_ID = 'gemini-1.5-pro';

// System prompt optimized for Gemini
const SYSTEM_PROMPT = `You are a helpful assistant that specializes in routing requests to Google's Gemini Pro model. You should:

1. Recognize and respond to any requests that mention Gemini, including phrases like:
   - "ask Gemini..."
   - "get Gemini to..."
   - "have Gemini..."
   - "tell Gemini..."
   Or any similar variations that imply the user wants to interact with Gemini.

2. For such requests:
   - Extract the actual query/task from the request
   - Remove the "ask Gemini" or similar prefix
   - Send the cleaned query to Gemini
   - Return Gemini's response

3. For requests that don't explicitly mention Gemini, process them normally using your own capabilities

4. Maintain conversation context and generate accurate responses

Please provide clear responses while acting as a seamless bridge to Gemini when requested.`;

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

interface Tool {
  functionDeclarations: FunctionDeclaration[];
}

interface MCPTool {
  name: string;
  callable: (...args: any[]) => Promise<any>;
  schema: {
    type: string;
    function: {
      name: string;
      description: string;
      parameters: any;
    };
  };
}

interface FunctionCall {
  name: string;
  args: Record<string, any>;
}

type ExtendedPart = Part & {
  functionCall?: FunctionCall;
  functionResponse?: {
    name: string;
    response: { result: any };
  };
};

interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  baseUrl?: string;
}

interface MCPServersConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

class MCPAgent {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private mcpClient: MCPClientImpl;
  private tools: { [key: string]: MCPTool } = {};

  constructor(apiKey: string, serverParams: MCPServerParameters) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: MODEL_ID,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192, // Increased output length
      },
    });
    this.mcpClient = new MCPClientImpl(serverParams);
  }

  async initialize(): Promise<void> {
    await this.mcpClient.connect();
    await this.setupTools();
  }

  private async setupTools(): Promise<void> {
    const mcpTools = await this.mcpClient.list_tools();
    this.tools = mcpTools.reduce((acc, tool) => {
      acc[tool.name] = {
        name: tool.name,
        callable: this.mcpClient.call_tool(tool.name),
        schema: {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        },
      };
      return acc;
    }, {} as { [key: string]: MCPTool });

    // Log available tools
    console.log('Available tools:');
    Object.values(this.tools).forEach(tool => {
      console.log(`- ${tool.name}: ${tool.schema.function.description}`);
    });
  }

  async processUserInput(
    input: string,
    messages: Content[] = []
  ): Promise<Content[]> {
    // Add system prompt if this is the first message
    if (messages.length === 0) {
      messages.push({
        role: 'system',
        parts: [{ text: SYSTEM_PROMPT }]
      });
    }

    // Check if this is a Gemini-specific request
    const geminiPatterns = [
      /^(?:ask|tell|get|have|let)\s+gemini\s+(?:to\s+)?(.+)/i,
      /^gemini[,:]?\s+(.+)/i,
      /^(?:can you )?(?:ask|tell|get|have|let)\s+gemini\s+(?:to\s+)?(.+)/i
    ];

    let cleanedInput = input;
    for (const pattern of geminiPatterns) {
      const match = input.match(pattern);
      if (match) {
        cleanedInput = match[1].trim();
        console.log('Detected Gemini request. Cleaned input:', cleanedInput);
        break;
      }
    }

    const contents: Content[] = [...messages];
    contents.push({ role: 'user', parts: [{ text: cleanedInput }] });

    const response = await this.model.generateContent({
      contents,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
      },
    });

    const result = await response.response;
    if (!result.candidates?.[0]?.content?.parts) {
      throw new Error('Invalid response from Gemini API');
    }

    contents.push({ role: 'model', parts: result.candidates[0].content.parts });

    for (const part of result.candidates[0].content.parts as ExtendedPart[]) {
      if (part.functionCall) {
        const { name, args } = part.functionCall;
        const toolResult = await this.tools[name].callable(args);

        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name,
                response: { result: toolResult },
              },
            } as ExtendedPart,
          ],
        });

        const followUpResponse = await this.model.generateContent({
          contents,
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 8192,
          },
        });

        const followUpResult = await followUpResponse.response;
        if (!followUpResult.candidates?.[0]?.content?.parts) {
          throw new Error('Invalid follow-up response from Gemini API');
        }

        contents.push({
          role: 'model',
          parts: followUpResult.candidates[0].content.parts,
        });
      }
    }

    return contents;
  }

  async disconnect(): Promise<void> {
    await this.mcpClient.disconnect();
  }
}

async function main() {
  // Load Claude Desktop config
  const homedir = require('os').homedir();
  const configPath = path.join(homedir, 'Library/Application Support/Claude/claude_desktop_config.json');
  
  let mcpConfig: MCPServersConfig;
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    mcpConfig = JSON.parse(configContent);
  } catch (error) {
    console.error('Failed to load Claude Desktop config:', error);
    process.exit(1);
  }

  // Get Gemini server config
  const geminiConfig = mcpConfig.mcpServers['gemini'];
  if (!geminiConfig) {
    throw new Error('Gemini MCP server configuration not found');
  }

  const apiKey = geminiConfig.env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found in environment or config');
  }

  // Configure MCP server parameters for Gemini
  const serverParams: MCPServerParameters = {
    command: geminiConfig.command,
    args: geminiConfig.args,
    env: {
      ...geminiConfig.env,
      GEMINI_API_KEY: apiKey
    }
  };

  const agent = new MCPAgent(apiKey, serverParams);
  await agent.initialize();

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let messages: Content[] = [];

  try {
    while (true) {
      const input = await new Promise<string>((resolve) => {
        readline.question('Enter your prompt (or "quit" to exit): ', resolve);
      });

      if (['quit', 'exit', 'q'].includes(input.toLowerCase())) {
        break;
      }

      try {
        messages = await agent.processUserInput(input, messages);
        // Find and display the last model message
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (message.role === 'model') {
            for (const part of message.parts) {
              if (part.text?.trim()) {
                console.log(`Assistant: ${part.text}`);
                break;
              }
            }
            break;
          }
        }
      } catch (error) {
        console.error('Error processing input:', error);
      }
    }
  } finally {
    readline.close();
    await agent.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} 