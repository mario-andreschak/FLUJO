# What FLUJO tells the AI

Every AI step (Process node) sends the AI a set of instructions before the
conversation. Most of it is yours: the Start node's prompt, the model's own
prompt and the step's prompt. Between the model's prompt and the step's prompt,
FLUJO adds a short part of its own under the heading `# GENERAL INFORMATION:`.

FLUJO's part only describes what the step can really do in this run. A step
with no tools is not told about tools, a step on its own is not told it works
with other agents, and a tool is named only when the step offers it.

Your own prompts are never changed. FLUJO's part says that your instructions
take priority over it.

## The parts

| Part | Added when the step | What it tells the AI |
|---|---|---|
| Basic rules | always | Answer the current request and stop; copy requested IDs exactly. With tools: it may make several tool calls. |
| Workflow and hand-offs | has a hand-off (an edge to another step, Finish or a Human step) | Which hand-off tools it has. With another AI step or Subflow: it is one step of a team and should do its own part. With Finish: write the answer before handing off. |
| Other agents | can call or start a sub-agent (Subflow), message its parent or children, or was started by another agent | How to run a sub-agent and wait, start one in the background, check or stop it, list and message agents, and that its final answer goes back to the agent that started it. |
| Asking people | can ask the user a question, hands off to a Human step, or can create a ticket | When to ask the user, which hand-off waits for a person, and that a ticket does not wait. |
| FLUJO tools | has tools from the built-in `flujo` app | How to find tools it does not have, read other conversations, keep small values across runs, and run other agents. Only the tools the step really has are named. |
| Stored results | can get long tool results back as a `flujo://run/…` link | To read the full result with `read_resource` instead of running the tool again. |

A meeting participant also gets the meeting rules. They are needed for the
meeting to work, so the switches below do not remove them.

## Leave parts out

1. Open the agent in **Expert view**, select the AI step and choose **Full
   settings** in the Inspector.
2. Open the **Input / output** tab.
3. To drop FLUJO's part completely, turn on **Exclude system prompt**.
4. To drop single parts, untick them under **Parts of FLUJO’s system prompt**.
   Ticked parts are still only added when the step can use them.
5. Choose **Save changes**, then **Save** to save the agent.

The **Prompt rendering order** box shows **FLUJO system prompt** while at least
one part is left in. In the **Task** tab, the preview shows the prompt as FLUJO
would build it from the drawing. A run can add a little more, for example tools
an app lists only when it is connected, or a note that another agent started it.

Chats that already started keep the instructions they started with. A change
applies to new chats, or to every turn when the step uses **Use current
instructions each turn**.

In a FlowSpec, use `"excludeSystemPrompt": true` or, for single parts,
`"excludeSystemPromptSections": ["workflow", "people"]`. The names are `basics`,
`workflow`, `agents`, `people`, `flujoTools` and `storedResults`.

## Why it is written this way

Model makers advise short, plain system prompts that say why a rule matters,
that leave the details of each tool to the tool's own description, and that
avoid shouting words like "MUST" (see Anthropic's
[prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
and OpenAI's [prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance)).
FLUJO's part follows that: it only adds what no single tool description can
say, such as how the tools fit together and when to stop. The two basic rules
about stopping and copying IDs are kept word for word, because recorded runs
showed they fix real mistakes.
