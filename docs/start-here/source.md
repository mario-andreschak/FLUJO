# Run FLUJO from source

## Prerequisites

- Node.js 22.23.4+ within 22.x, or 24.22.1+ within 24.x ([runtime compatibility evidence](../../docs/operations/windows-native-runtime-profile.md))
- claude code (optional, if you want to use Anthropic Subscription)
- python (optional, if you want to use python-based MCP servers)
- pip (optional, if you want to use python-based MCP servers that build with pip)
- uv and/or yarn (optional, if you prefer these over npm or pip)
- ripgrep (optional filesystem-search acceleration; the installer adds it automatically)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/mario-andreschak/FLUJO.git
   cd FLUJO
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Start the development server:
   ```bash
   npm run dev
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

[Back to installation](install.md) · [Start here](README.md)
