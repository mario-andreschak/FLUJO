import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Try to read from a local OpenAPI spec file if it exists
function getLocalOpenApiSpec() {
  try {
    const specPath = path.join(process.cwd(), "src", "openapi.json");
    if (fs.existsSync(specPath)) {
      const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
      return spec;
    }
  } catch (error) {
    console.error("Error reading OpenAPI spec file:", error);
  }
  return null;
}

export async function GET() {
  const apiSpec = {
    openapi: "3.0.0",
    info: {
      title: "FLUJO API Reference",
      description:
        "Complete API documentation for integrating with FLUJO's headless mode",
      version: "1.0.1",
    },
    servers: [
      {
        url: "/api",
        description: "Current server",
      },
    ],
    tags: [
      {
        name: "Flow Execution",
        description: "Endpoints for executing and managing flows",
      },
      {
        name: "MCP Server Management",
        description: "Endpoints for managing MCP servers",
      },
      {
        name: "OpenAI-Compatible API",
        description: "OpenAI-compatible endpoints for AI interactions",
      },
      { name: "Models", description: "Endpoints for managing AI models" },
      { name: "Storage", description: "Endpoints for data storage operations" },
      {
        name: "Environment",
        description: "Endpoints for managing environment variables",
      },
      { name: "System", description: "System-related endpoints" },
    ],
    paths: {
      "/flow/execute/{flowName}": {
        post: {
          tags: ["Flow Execution"],
          summary: "Execute a specific flow by name",
          description:
            "This endpoint allows you to execute a specific flow by name.",
          parameters: [
            {
              name: "flowName",
              in: "path",
              description: "The name of the flow to execute",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["messages"],
                  properties: {
                    messages: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["role", "content"],
                        properties: {
                          role: {
                            type: "string",
                            enum: ["user", "system", "assistant"],
                            description: "The role of the message sender",
                          },
                          content: {
                            type: "string",
                            description: "The content of the message",
                          },
                        },
                      },
                    },
                    parameters: {
                      type: "object",
                      description: "Optional parameters to pass to the flow",
                      additionalProperties: true,
                    },
                  },
                },
                examples: {
                  basic: {
                    value: {
                      messages: [
                        { role: "user", content: "Example message content" },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Flow executed successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      flowExecutionId: {
                        type: "string",
                        description: "The unique ID of the flow execution",
                      },
                      result: {
                        type: "object",
                        description: "The result of the flow execution",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/flow/list": {
        get: {
          tags: ["Flow Execution"],
          summary: "List all available flows",
          description: "Returns a list of all available flows",
          responses: {
            "200": {
              description: "List of flows",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      flows: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            description: { type: "string" },
                            active: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/mcp/servers": {
        get: {
          tags: ["MCP Server Management"],
          summary: "List all MCP servers",
          description: "Returns a list of all MCP servers",
          responses: {
            "200": {
              description: "List of MCP servers",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      servers: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            status: {
                              type: "string",
                              enum: [
                                "online",
                                "offline",
                                "starting",
                                "stopping",
                              ],
                            },
                            url: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        post: {
          tags: ["MCP Server Management"],
          summary: "Create a new MCP server",
          description: "Creates a new MCP server",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: {
                      type: "string",
                      description: "Server name",
                    },
                    config: {
                      type: "object",
                      description: "Server configuration",
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Server created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/mcp/servers/{serverId}": {
        get: {
          tags: ["MCP Server Management"],
          summary: "Get MCP server details",
          description: "Returns details for a specific MCP server",
          parameters: [
            {
              name: "serverId",
              in: "path",
              description: "Server ID",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Server details",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      status: { type: "string" },
                      config: { type: "object" },
                    },
                  },
                },
              },
            },
            "404": { description: "Server not found" },
          },
        },

        delete: {
          tags: ["MCP Server Management"],
          summary: "Delete an MCP server",
          description: "Deletes a specific MCP server",
          parameters: [
            {
              name: "serverId",
              in: "path",
              description: "Server ID",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "204": { description: "Server deleted successfully" },
            "404": { description: "Server not found" },
          },
        },
      },

      "/openai/chat/completions": {
        post: {
          tags: ["OpenAI-Compatible API"],
          summary: "Create a chat completion",
          description: "Creates a completion for the chat message",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["model", "messages"],
                  properties: {
                    model: {
                      type: "string",
                      description: "ID of the model to use",
                    },
                    messages: {
                      type: "array",
                      description:
                        "A list of messages comprising the conversation so far",
                      items: {
                        type: "object",
                        required: ["role", "content"],
                        properties: {
                          role: {
                            type: "string",
                            enum: ["system", "user", "assistant", "function"],
                            description:
                              "The role of the author of this message",
                          },
                          content: {
                            type: "string",
                            description: "The contents of the message",
                          },
                        },
                      },
                    },
                    temperature: {
                      type: "number",
                      description: "What sampling temperature to use",
                      default: 1,
                      minimum: 0,
                      maximum: 2,
                    },
                    stream: {
                      type: "boolean",
                      description: "Whether to stream back partial progress",
                      default: false,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      object: { type: "string" },
                      created: { type: "integer" },
                      model: { type: "string" },
                      choices: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            index: { type: "integer" },
                            message: {
                              type: "object",
                              properties: {
                                role: { type: "string" },
                                content: { type: "string" },
                              },
                            },
                            finish_reason: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/model": {
        get: {
          tags: ["Models"],
          summary: "List or get models",
          description: "List all models or get details for a specific model",
          parameters: [
            {
              name: "action",
              in: "query",
              description: "Action to perform",
              schema: {
                type: "string",
                enum: ["listModels", "getModel"],
              },
            },
            {
              name: "id",
              in: "query",
              description: "Model ID (required when action is getModel)",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      models: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            provider: { type: "string" },
                            config: { type: "object" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        post: {
          tags: ["Models"],
          summary: "Add, update, or delete a model",
          description: "Add, update, or delete a model based on the action",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: {
                      type: "string",
                      enum: ["addModel", "updateModel", "deleteModel"],
                      description: "Action to perform",
                    },
                    model: {
                      type: "object",
                      description:
                        "Model data (required for addModel and updateModel)",
                      properties: {
                        name: { type: "string" },
                        provider: { type: "string" },
                        apiKey: { type: "string" },
                        config: { type: "object" },
                      },
                    },
                    id: {
                      type: "string",
                      description: "Model ID (required for deleteModel)",
                    },
                  },
                  required: ["action"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Model updated successfully" },
            "201": { description: "Model created successfully" },
            "204": { description: "Model deleted successfully" },
          },
        },
      },

      "/flow/create": {
        post: {
          tags: ["Flow Execution"],
          summary: "Create a new flow",
          description: "Creates a new flow with the specified configuration",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: {
                      type: "string",
                      description: "Flow name",
                    },
                    description: {
                      type: "string",
                      description: "Flow description",
                    },
                    nodes: {
                      type: "array",
                      description: "Flow nodes",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          type: { type: "string" },
                          position: {
                            type: "object",
                            properties: {
                              x: { type: "number" },
                              y: { type: "number" },
                            },
                          },
                          data: { type: "object" },
                        },
                      },
                    },
                    edges: {
                      type: "array",
                      description: "Flow edges",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          source: { type: "string" },
                          target: { type: "string" },
                          sourceHandle: { type: "string" },
                          targetHandle: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Flow created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/flow/{flowId}": {
        get: {
          tags: ["Flow Execution"],
          summary: "Get flow details",
          description: "Returns details for a specific flow",
          parameters: [
            {
              name: "flowId",
              in: "path",
              description: "Flow ID",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Flow details",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                      nodes: { type: "array" },
                      edges: { type: "array" },
                    },
                  },
                },
              },
            },
          },
        },

        delete: {
          tags: ["Flow Execution"],
          summary: "Delete a flow",
          description: "Deletes a specific flow",
          parameters: [
            {
              name: "flowId",
              in: "path",
              description: "Flow ID",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "204": { description: "Flow deleted successfully" },
          },
        },
      },

      "/env": {
        get: {
          tags: ["Environment"],
          summary: "Get environment variables",
          description: "Gets all environment variables or a specific variable",
          parameters: [
            {
              name: "key",
              in: "query",
              description: "Specific environment variable key",
              schema: { type: "string" },
            },
            {
              name: "includeSecrets",
              in: "query",
              description: "Whether to include sensitive values",
              schema: { type: "boolean" },
            },
          ],
          responses: {
            "200": {
              description: "Environment variables",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      variables: {
                        type: "object",
                        additionalProperties: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        post: {
          tags: ["Environment"],
          summary: "Set environment variables",
          description: "Sets or deletes environment variables",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: {
                      type: "string",
                      enum: ["set", "setAll", "delete"],
                      description: "Action to perform",
                    },
                    key: {
                      type: "string",
                      description: "Environment variable key",
                    },
                    value: {
                      type: "string",
                      description: "Environment variable value",
                    },
                    variables: {
                      type: "object",
                      description: "Multiple variables to set",
                      additionalProperties: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Operation completed successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/storage": {
        get: {
          tags: ["Storage"],
          summary: "Get data from storage",
          description: "Retrieves data from storage by key",
          parameters: [
            {
              name: "key",
              in: "query",
              description: "Storage key",
              required: true,
              schema: {
                type: "string",
                enum: [
                  "models",
                  "mcp_servers",
                  "flows",
                  "settings",
                  "env_vars",
                ],
              },
            },
          ],
          responses: {
            "200": {
              description: "Stored data",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },

        post: {
          tags: ["Storage"],
          summary: "Save data to storage",
          description: "Saves data to storage",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["key", "value"],
                  properties: {
                    key: {
                      type: "string",
                      enum: [
                        "models",
                        "mcp_servers",
                        "flows",
                        "settings",
                        "env_vars",
                      ],
                    },
                    value: {
                      type: "object",
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Data saved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/version": {
        get: {
          tags: ["System"],
          summary: "Get system version",
          description: "Returns the current version of the system",
          responses: {
            "200": {
              description: "Version information",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      version: { type: "string" },
                      buildNumber: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/health": {
        get: {
          tags: ["System"],
          summary: "Check system health",
          description: "Returns the health status of the system",
          responses: {
            "200": {
              description: "Health information",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: {
                        type: "string",
                        enum: ["ok", "degraded", "error"],
                      },
                      components: {
                        type: "object",
                        additionalProperties: {
                          type: "object",
                          properties: {
                            status: { type: "string" },
                            message: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return NextResponse.json(apiSpec);
}
