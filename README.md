# gemini-mcp-server

A TypeScript implementation of a Model Context Protocol (MCP) server that integrates with Google's Gemini Pro model.

## MCP Tools

### generate_text
*From server: gemini*

Generates text using Google's Gemini Pro model. This tool provides natural language generation capabilities through the MCP protocol.

Input Schema:
```json
{
  "prompt": "string",  // The text prompt to generate from
  "temperature": "number?", // Optional: Controls randomness (0-1, default: 0.7)
  "maxOutputTokens": "number?", // Optional: Maximum output length (1-8192, default: 8192)
  "topK": "number?", // Optional: Top-k sampling parameter (1-40)
  "topP": "number?", // Optional: Top-p sampling parameter (0-1)
  "stream": "boolean?" // Optional: Enable streaming response (default: false)
}
```

Output Schema:
```json
{
  "text": "string"  // The generated text response
}
```

## Prerequisites

- Node.js 18 or higher
- Google Gemini API key
- TypeScript
- Claude Desktop app

## Installation

1. Clone the repository:
```bash
git clone https://github.com/GeorgeJeffers/gemini-mcp-server.git
cd gemini-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with your Google API key:
```bash
GOOGLE_API_KEY=your_api_key_here
```

4. Build and start the server:
```bash
npm run build
npm start
```

## Claude Desktop Integration

To use this server with Claude Desktop:

1. Open Claude Desktop
2. Go to Settings > Developer
3. Click "Edit Config"
4. Add the following configuration:

```json
{
  "name": "gemini",
  "command": "node",
  "args": ["dist/gemini_mcp_server.js"],
  "env": {
    "GEMINI_API_KEY": "your_api_key_here"
  },
  "cwd": "/path/to/mcp-gemini-server"
}
```

Replace:
- `/path/to/mcp-gemini-server` with the absolute path to where you cloned this repository
- `your_api_key_here` with your actual Google Gemini API key

The server will now be available in Claude Desktop's MCP server list.

## License

MIT

## Author

GeorgeJeffers