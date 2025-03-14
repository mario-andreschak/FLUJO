export const MASKED_STRING = 'masked:********';

export const ToolCallDefaultPatternJSON = '{"tool": "TOOL_NAME", "parameters": {"PARAM_NAME1":"PARAM_VALUE1$", "$PARAM_NAME2":"$PARAM_VALUE2$", "...": "..." }}'
export const ToolCallDefaultPatternXML = '<TOOL_NAME><PARAM_NAME1>PARAM_VALUE1</PARAM_NAME1><PARAM_NAME2>PARAM_VALUE1</PARAM_NAME2></TOOL_NAME>'

export const ReasoningDefaultPatternJSON = '{"think": "THINK_TEXT"}'
export const ReasoningDefaultPatternXML = '<THINK>THINK_TEXT</THINK>'

export const ReasoningDefaultPattern = ReasoningDefaultPatternJSON
export const ToolCallDefaultPattern = ToolCallDefaultPatternJSON


export const xmlFindPattern = '<([\w-]+)>(?:.+)<\/(\{1})>'