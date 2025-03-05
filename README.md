![i6tPUEYtog0qXnrt-generated_image](https://github.com/user-attachments/assets/881ad34c-73fa-4b71-ba47-123b5da8e05e)

# FLUJO
MCP-Hub and -Bride, Multi-Model Workflow and Chat Interface 

Coming soon.
 ![image](https://github.com/user-attachments/assets/c745da69-1106-43d8-8fbd-49fe6eb64d9f)

FLUJO aims to close the gap between workflow orchestration (similar to n8n, ActivePieces, etc.), Model-Context-Protocol and Integration with other AI Tools like CLine or Roo. All locally, all open-source.
Currently, with FLUJO you can...
•	Store environment variables and API keys (encrypted) globally in the app, so your API-Keys and passwords are not all over the place.
![image](https://github.com/user-attachments/assets/20da1059-73e7-48cf-b6f2-27b11b5f7507)


•	Manage different Models with pre-defined prompts, API-Keys or (openAI compatible) providers: You want to use Claude for 10 different things, with different system-instructions? Here you go!
   ![image](https://github.com/user-attachments/assets/cf67d330-8025-474d-8ad4-6fc4cbef0c9f)
![image](https://github.com/user-attachments/assets/a38eb2e3-7fa2-4250-a5fd-75d844d0f751)
![image](https://github.com/user-attachments/assets/d448881c-d173-4ffa-a733-3c43082249d4)

•	Can connect to Ollama models exposed with `ollama serve`: Orchestrate locally! Use the big brains online for the heavy task - but let a local ollama model to the tedious file-writing or git-commit. That keeps load off the online models and your wallet a bit fuller.
•	Install MCP servers from Github (depends on the readme quality and MCP server): No struggling with servers that are not yet available through Smithery or OpenTools.
 ![image](https://github.com/user-attachments/assets/c11fbf1b-8970-43e9-a040-fd0452293c12)

•	Manage and Inspect MCP Servers (only tools for now. Resources, Prompts and Sampling are coming soon)
 ![image](https://github.com/user-attachments/assets/2eaae63f-0a31-4ce7-80e8-bcc8ec8dd74f)

•	Bind MCP Servers' .env-variables (like api keys) to the global encrypted storage: You set your API-KEY once, and not a thousand times.
 dd
•	Create, design and execute Flows by connecting "Processing" Nodes with MCP servers and allowing/restricting individual tools: Keep it simple for your model - no long system prompts, not thousand available tools that confuse your LLM - give your Model exactly what it needs in this step!
  
•	Mix & match System-Prompts configured in the Model, the Flow or the Processing Node: More power over your Prompt design - no hidden magic.
 
•	Reference tools directly in prompts: Instead of explaining a lot, just drag the tool into the prompt and it auto-generates a instruction for your LLM on how to use the Tool.
•	Interact with Flows using a Chat Interface: Select a Flow an Talk to your Models. Let them do your work (whatever the MCP Servers allow them to do, however you designed the Flow) and report back to you!
 
•	With manual disabling of single messages in the conversation or splitting it into a new conversation: Reduce Context Size however you want!
 
•	Attach Documents or Audio to your Chat messages for the LLM to process.
 
•	Integrate FLUJO in other applications like CLine or Roo (FLUJO provides an OpenAI compatible ChatCompletions Endpoint) - still WIP
  Work-in-Progress
I am still refining the last things, and I will probably release this weekend on Github. Meanwhile, I'd appreciate your ideas or feature requests!
Stay tuned - start flowing soon...!



UPDATE 03/04/25 - Feature complete for preview. Double checking all structures and documentations. Preparing final tests. We're almost there :)
