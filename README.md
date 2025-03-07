![i6tPUEYtog0qXnrt-generated_image](https://github.com/user-attachments/assets/881ad34c-73fa-4b71-ba47-123b5da8e05e)

# FLUJO
MCP-Hub and -Bride, Multi-Model Workflow and Chat Interface 

Coming soon.
 ![image](https://github.com/user-attachments/assets/c745da69-1106-43d8-8fbd-49fe6eb64d9f)

FLUJO aims to close the gap between **workflow orchestration** (similar to n8n, ActivePieces, etc.), **Model-Context-Protocol** and **Integration** with other AI Tools like Cursor, Windsurf, CLine or Roo. All **locally** (if you want), all **open-source**.

Currently, with FLUJO you can...

•	**Store environment variables and API keys** (encrypted) globally in the app, so your API-Keys and passwords are not all over the place.

![Screenshot 2025-02-27 182327](https://github.com/user-attachments/assets/f5acd60f-129d-4e0c-8bc1-b5410d3c8d1d)

•	Manage **different Models** with **pre-defined prompts**, **API-Keys** or (openAI compatible) **providers**: You want to use Claude for 10 different things, with different system-instructions? Or one Claude using OpenRouter and one using Anthrophic directly? Here you go!

![Screenshot 2025-02-27 184857](https://github.com/user-attachments/assets/06036daa-c576-4483-b13e-47ef21a82395)

![Screenshot 2025-02-27 184631](https://github.com/user-attachments/assets/4e6f8390-eaab-448a-9a38-bbbd64fd3de8)

![image](https://github.com/user-attachments/assets/88f1a49f-2bb5-4d3c-aad3-7e8f61afd6b3)


•	Can connect to **Ollama models** exposed with `ollama serve`: Orchestrate locally! **Use the big brains online for the heavy task - but let a local ollama model to the tedious file-writing or git-commit.** That keeps load off the online models and your wallet a bit fuller. Just put your ollama URL into the Model BaseUrl.

![image](https://github.com/user-attachments/assets/8a04632a-4cc2-4738-ac9b-e856170a9e7c)

•	**Install MCP servers from Github** or local filesystem (depends on the readme quality and MCP server): No struggling with servers that are not yet available through Smithery or OpenTools.

![image](https://github.com/user-attachments/assets/4c4055fd-c769-4155-b48f-1350b689545f)
![image](https://github.com/user-attachments/assets/bd10b76f-aeb0-48c2-98e3-313e35ace50f)
![image](https://github.com/user-attachments/assets/7ad857f1-ab7b-40ff-8bdb-b8c0ff8c8391)
![image](https://github.com/user-attachments/assets/6967dd38-4fdf-4d11-b854-dda6d1c3ecc6)


•	**Manage and Inspect MCP Servers** (only tools for now. Resources, Prompts and Sampling are coming soon)

![image](https://github.com/user-attachments/assets/a29effb6-07d4-42e2-886f-6cf7c96fe4a6)

•	Bind MCP Servers' **.env-variables** (like api keys) to the **global encrypted storage**: You set your API-KEY once, and not a thousand times.
 
![image](https://github.com/user-attachments/assets/27b257bf-a6ad-42bf-9ccf-4178c454c7ce)

•	**Create, design and execute Flows** by **connecting Models** (Processing Nodes) **with MCP servers and allowing/restricting individual tools**: Keep it simple for your model - no long system prompts, not thousand available tools that confuse your LLM - give your Model exactly what it needs in this step!

![Screenshot 2025-02-27 205818](https://github.com/user-attachments/assets/30fc4c8f-78fe-4a44-9fe7-d7837d7359d2)

![Screenshot 2025-02-27 205856](https://github.com/user-attachments/assets/6b84025f-5240-4277-87e9-02e0f5aac867)

•	Mix & match **System-Prompts** configured in the Model, the Flow or the Processing Node: More power over your Prompt design - (almost) no hidden magic.

![image](https://github.com/user-attachments/assets/b1725c4d-2b0f-420d-92cc-3eba13a5a7de)

![image](https://github.com/user-attachments/assets/fc97c613-714d-48bc-a43b-704d56cf0341)


•	**Reference tools directly in prompts**: Instead of explaining a lot, just drag the tool into the prompt and it **auto-generates an instruction** for your LLM on how to use the Tool.

![image](https://github.com/user-attachments/assets/8bc8ee61-2f21-42ef-b1df-9c88a4ad13a6)

![image](https://github.com/user-attachments/assets/f6edb3eb-1a2f-4cb4-838c-eddd4a107d98)

•	**Interact with Flows** using a **Chat Interface**: Select a Flow an Talk to your Models. Let them do your work (whatever the MCP Servers allow them to do, however you designed the Flow) and report back to you!

 ![image](https://github.com/user-attachments/assets/ce6b5f15-c500-4129-a1f7-131517a65f14)

•	With the option to manually **"disable" single messages** in the conversation or **split it into a new conversation**: Reduce Context Size however you want!

 ![image](https://github.com/user-attachments/assets/625b90d6-73e2-4afe-9ec4-5814b0bbf302)

•	Attach Documents or Audio to your Chat messages for the LLM to process.

 ![image](https://github.com/user-attachments/assets/3f7f737a-170c-48e8-b9b1-3969da50d8e0)

•	Integrate FLUJO in other applications like CLine or Roo (FLUJO provides an **OpenAI compatible ChatCompletions Endpoint**) - still WIP
  Work-in-Progress
  ![image](https://github.com/user-attachments/assets/4e528d28-a317-4326-8da6-6c6dc4a6232b)

![image](https://github.com/user-attachments/assets/d8d8fe98-f08e-40eb-9ad8-a494aad32826)



----- I am still refining the last things, and I will probably release this weekend as a alpha -----
