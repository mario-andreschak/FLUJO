export const MASKED_STRING = 'masked:********';
// export const ToolCallDefaultPattern = '{\n  "tool": "$TOOL_NAME",\n  "parameters": {\n    "$PARAM_NAME1": "$PARAM_VALUE1$",\n    "$PARAM_NAME2": "$PARAM_VALUE2$",\n    "...": "..."\n  }\n}'
export const ToolCallDefaultPattern = '<TOOL_NAME><PARAM_NAME1>PARAM_VALUE1</PARAM_NAME1><PARAM_NAME2>PARAM_VALUE1</PARAM_NAME2>'
// export const ReasoningDefaultPattern = '{"reasoning": "$REASONING", "message": "$MESSAGE"}'
export const ReasoningDefaultPattern = '<THINK>TEXT</THINK>'
