# DISCLAIMER
FLUJO is still an early preview!

## ⚡ Quick Install (Windows)

Install everything (Git, Node.js, Python, uv), clone FLUJO, build it, and optionally start it with a single PowerShell command:

Press start, type powershell, press Enter, copy & paste the command below and press Enter again.

```powershell
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

Prefer to set it up manually? See [Getting Started](#-getting-started). To remove FLUJO later, see [Uninstalling](#uninstalling-windows).

## A few words in advance

For *anything* that you struggle with (MCP Installation, Application Issues, Usability Issues, Feedback): **PLEASE LET ME KNOW!**
-> Create a Github Issue or write on Discord (https://discord.gg/KPyrjTSSat) and I will look into it! Maybe a response will take a day, but I will try to get back to each and every one of you.


FLUJO animated Short #1 - "A sad song about MCP"
[![image](https://github.com/user-attachments/assets/e83cf81d-e5db-451c-9599-77dcdbe4ba2c)](https://www.youtube.com/watch?v=boOS9XHQdZc)

![FLUJO Logo](https://github.com/user-attachments/assets/881ad34c-73fa-4b71-ba47-123b5da8e05e)

# FLUJO

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)

FLUJO is an open-source platform that bridges the gap between **workflow orchestration**, **Model-Context-Protocol (MCP)**, and **AI tool integration**. It provides a unified interface for managing AI models, MCP servers, and complex workflows - all locally and open-source.

![FLUJO Overview](https://github.com/user-attachments/assets/397ef3a5-e4c1-4667-ac74-6fe96f854ff1)

FLUJO is powered by the [PocketFlowFramework](https://the-pocket-world.github.io/Pocket-Flow-Framework/) and built with [CLine](https://github.com/cline/cline) and a lot of LOVE.

## 🌟 Key Features

### 🔑 Environment & API Key Management

- **Secure Storage**: Store environment variables and API keys with encryption
- **Global Access**: Use your stored keys across the entire application
- **Centralized Management**: Keep all your credentials in one secure place

![API Keys Management](https://github.com/user-attachments/assets/f5acd60f-129d-4e0c-8bc1-b5410d3c8d1d)

### 🤖 Model Management

- **Multiple Models**: Configure and use different AI models simultaneously
- **Pre-defined Prompts**: Create custom system instructions for each model
- **Provider Flexibility**: Connect to various API providers (OpenAI, Anthropic, etc.)
- **Local Models**: Integrate with Ollama for local model execution

![Model Configuration](https://github.com/user-attachments/assets/06036daa-c576-4483-b13e-47ef21a82395)
![Model Settings](https://github.com/user-attachments/assets/4e6f8390-eaab-448a-9a38-bbbd64fd3de8)
![Ollama Integration](https://github.com/user-attachments/assets/8a04632a-4cc2-4738-ac9b-e856170a9e7c)

### 🔌 MCP Server Integration

- **Easy Installation**: Install MCP servers from GitHub or local filesystem
- **Server Management**: Comprehensive interface for managing MCP servers
- **Tool Inspection**: View and manage available tools from MCP servers
- **Environment Binding**: Connect server environment variables to global storage

![MCP Server Installation](https://github.com/user-attachments/assets/4c4055fd-c769-4155-b48f-1350b689545f)
![MCP Server Management](https://github.com/user-attachments/assets/bd10b76f-aeb0-48c2-98e3-313e35ace50f)
![MCP Server Tools](https://github.com/user-attachments/assets/a29effb6-07d4-42e2-886f-6cf7c96fe4a6)
![MCP Environment Variables](https://github.com/user-attachments/assets/27b257bf-a6ad-42bf-9ccf-4178c454c7ce)

### 🔄 Workflow Orchestration

- **Visual Flow Builder**: Create and design complex workflows
- **Model Integration**: Connect different models in your workflow
- **Tool Management**: Allow or restrict specific tools for each model
- **Prompt Design**: Configure system prompts at multiple levels (Model, Flow, Node)
![image](https://github.com/user-attachments/assets/36d417ca-a0e6-4f87-90cb-b17a70641372)
![Flow Design](https://github.com/user-attachments/assets/30fc4c8f-78fe-4a44-9fe7-d7837d7359d2)
![Flow Configuration](https://github.com/user-attachments/assets/6b84025f-5240-4277-87e9-02e0f5aac867)
![System Prompts](https://github.com/user-attachments/assets/b1725c4d-2b0f-420d-92cc-3eba13a5a7de)
![Tool References](https://github.com/user-attachments/assets/8bc8ee61-2f21-42ef-b1df-9c88a4ad13a6)
![Screenshot 2025-03-08 223218](https://github.com/user-attachments/assets/922b9368-c0b6-4a06-b500-c8d71506173a)

### 💬 Chat Interface

- **Flow Interaction**: Interact with your flows through a chat interface
- **Message Management**: Edit or disable messages or split conversations to reduce context size 
- **File Attachments**: Attach documents or audio for LLM processing (really bad atm, because for this you should use mcp!)
- **Transcription**: Process audio inputs with automatic transcription (really bad atm, see roadmap)
  
![Screenshot 2025-04-05 210835](https://github.com/user-attachments/assets/c9738f5b-01c7-4b18-b816-2323ebc2a94a)

### 🔄 External Tool Integration

- **OpenAI Compatible Endpoint**: Integrate with tools like Cline or Roo Code. In the client, choose the **OpenAI Compatible** provider, set the **Base URL** to `http://localhost:4200/v1` (note: `/v1`, not `/v1/models`), put any value as the API key, and pick a **model** named `flow-<your-flow-name>` (the list comes from `/v1/models`).
- **FLUJO as an MCP server (proxy)**: Re-expose any configured MCP server to external MCP clients (Claude Desktop, Cursor, Cline, …) so you set a server up once in FLUJO and use it everywhere. Toggle **"Expose to external apps"** on the server's card, then add a **Streamable-HTTP** MCP server in your client pointing at `http://localhost:4200/mcp-proxy/<server-name>`. (Localhost-only in the current version.)
- **Seamless Connection**: Use FLUJO as a backend for other AI applications

> **Note:** to consume flows from other apps, use the **OpenAI Compatible** provider (above). FLUJO does not expose an Ollama-compatible *server* endpoint. (Connecting FLUJO *to* a local Ollama instance as a model provider is a separate, supported feature.)

![Screenshot 2025-03-27 130144](https://github.com/user-attachments/assets/7ba68655-2a38-48b1-8d52-c0e2c217e506)
![Screenshot 2025-03-26 213657](https://github.com/user-attachments/assets/43add66a-ba69-4651-9722-f920c4ef746b)

## 🚀 Getting Started

### Manual installation:
### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/mario-andreschak/FLUJO.git
   cd FLUJO
   ```

2. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```

3. Start the development server:
   ```bash
   npm run dev
   # or
   yarn dev
   ```

4. Open your browser and navigate to:
   ```
   http://localhost:4200
   ```
   
5. FLUJO feels and works best if you run it compiled:
   ```bash
   npm run build
   npm start
   ```

### One-line install (Windows)

On a fresh Windows machine you can install everything (Git, Node.js, Python, uv),
clone FLUJO, build it, and optionally start it with a single PowerShell command:

```powershell
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

By default FLUJO is installed into `%LOCALAPPDATA%\FLUJO`. To customise the install
without the interactive prompt, set environment variables first, e.g.:

```powershell
$env:FLUJO_DIR = "D:\Apps\FLUJO"; $env:FLUJO_START = "1"; irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

See [`scripts/install.ps1`](scripts/install.ps1) for all options.

### Uninstalling (Windows)

To remove FLUJO, run the uninstaller:

```powershell
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/uninstall.ps1 | iex
```

or, from inside your install folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

It asks, per prerequisite (Git, Node.js, Python, uv), whether to remove it — defaulting
to **yes** for ones FLUJO installed and **no** for ones that were already on your system
— then removes the `flujo` command and the FLUJO folder.

> ⚠️ **This permanently deletes your data.** All flows, encrypted API keys, MCP server
> configs and chat history live in `<install>\db\` and are removed with the folder. Use
> FLUJO's built-in backup/export first if you want to keep them.

Installs created before this feature have no manifest; the uninstaller then defaults every
prerequisite to **keep** (it can't tell which FLUJO installed). Re-running the installer
once writes the manifest for future uninstalls. See
[`scripts/uninstall.ps1`](scripts/uninstall.ps1) for details.

## 📖 Usage

### Setting up often used API keys

1. Navigate to Settings
2. Save your API Keys globally to secure them

### Setting Up Models

1. Navigate to the Models page
2. Click "Add Model" to create a new model configuration
3. Configure your model with name, provider, API key, and system prompt
4. Save your configuration

### Managing MCP Servers

1. Go to the MCP page
2. Click "Add Server" to install a new MCP server
3. Choose from GitHub repository or local filesystem
4. Configure server settings and environment variables
5. Start and manage your server

### Using SSE MCP-Servers
1. Got to the MCP Page
2. Click "Add Server" to install a new MCP server
3. Select "Local Server"
4. Enter a Server Name, enter "/" as Server Root Path
5. Leave Build Command and Install Command empty
6. Enter "npx" as Run Command
7. Add 1. Argument "mcp-remote"
8. Add 2. Argument "(your MCP SSE-Url here)"
   ![image](https://github.com/user-attachments/assets/f5c97c26-72c6-4ba9-a9d2-a34e3f34ec19)


### Using official Reference servers

1. Go to the MCP page
2. Click "Add Server" to install a new MCP server
3. Go to the "Reference Servers" Tab
4. (First time executing:) Click "Refresh" and waaaaaaait.
5. Click a server of your choice, wait for the screen to change, click "Save" / "Update Server" at the bottom.
   
### Creating Workflows

1. Visit the Flows page
2. Click "Create Flow" to start a new workflow
3. Add processing nodes and connect them 
4. Configure each node with models and tools
5. Save your flow

![Screenshot 2025-04-12 123657](https://github.com/user-attachments/assets/06b40a36-a906-44d5-b53a-9eaa125acb74)


### Branching

1. Connect one MCP node to multiple subsequent ones
![Screenshot 2025-04-07 094237](https://github.com/user-attachments/assets/73be3153-5dea-4729-bf10-40657b2a12c4)
2. Define the branching in the prompt, using the handoff-tools on the "Agent Tools" tab
![Screenshot 2025-04-07 095433](https://github.com/user-attachments/assets/d3bc188f-8a7a-4fb0-830c-e4d85a9a37bf)

### Loops

1. Same as branching, but connect back to a previous node
![Screenshot 2025-04-08 165640](https://github.com/user-attachments/assets/3c026812-a895-4c3a-a37d-fe51550b273b)

### Orchestration

1. Same as loops but with multiple ones
![Screenshot 2025-04-08 180631](https://github.com/user-attachments/assets/0a3abfe9-8e83-49ea-a8da-bede3bed31e3)



### Using the Chat Interface

1. Go to the Chat page
2. Select a flow to interact with
3. Start chatting with your configured workflow
![Screenshot 2025-04-07 095653](https://github.com/user-attachments/assets/efcb78ba-9a85-401e-a4c7-df5ec7458b26)


## 🔄 MCP Integration

FLUJO provides comprehensive support for the Model Context Protocol (MCP), allowing you to:

- Install and manage MCP servers
- Inspect server tools
- Connect MCP servers to your workflows
- Reference tools directly in prompts
- Bind environment variables to your global encrypted storage
![image](https://github.com/user-attachments/assets/4c638f0d-a6cb-4f4f-a3c0-cc1e3a369297)

## 📄 License

FLUJO is licensed under the [MIT License](LICENSE).
## 🚀 Roadmap
Here's a roadmap of upcoming features and improvements:

- Real-time Voice Feature: Adding support for Whisper.js or OpenWhisper to enable real-time voice capabilities.
- Visual Debugger: Introducing a visual tool to help debug and troubleshoot more effectively.
- MCP Roots Support: Implementing Checkpoints and Restore features within MCP Roots for better control and recovery options.
- MCP Prompts: Enabling users to build custom prompts that fully leverage the capabilities of the MCP server.
- MCP Proxying STDIO<>SSE: Likely utilizing SuperGateway to proxy standard input/output with Server-Sent Events for enhanced communication: Use MCP Servers managed in FLUJo in any other MCP client.
- Enhanced Integrations: Improving compatibility and functionality with tools like Windsurf, Cursor, and Cline.
- Advanced Orchestration: Adding agent-driven orchestration, batch processing, and incorporating features inspired by Pocketflow.
- Online Template Repository: Creating a platform for sharing models, flows, or complete "packages," making it easy to distribute FLUJO flows to others.
- Edge Device Optimization: Enhancing performance and usability for edge devices.

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📬 Contact

- GitHub: [mario-andreschak](https://github.com/mario-andreschak)
- LinkedIn: https://www.linkedin.com/in/mario-andreschak-674033299/

## Notes:
- You can add ~FLUJO=HTML, ~FLUJO=MARKDOWN, ~FLUJO=JSON, ~FLUJO=TEXT in your message to format the response, this will give varying results in different tools where you integrate FLUJO.
- You can add ~FLUJOEXPAND=1 or ~FLUJODEBUG=1 somewhere in your message to show more details
- in config/features.ts you can change the Logging-level for the whole application
- in config/features.ts you can enable SSE support which is currently disabled by default
---

FLUJO - Empowering your AI workflows with open-source orchestration.

#
