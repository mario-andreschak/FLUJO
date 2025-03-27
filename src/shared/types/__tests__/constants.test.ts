/**
 * @jest-environment node
 */
import {
  MASKED_STRING,
  ToolCallDefaultPatternJSON,
  ToolCallDefaultPatternXML,
  ReasoningDefaultPatternJSON,
  ReasoningDefaultPatternXML,
  ReasoningDefaultPattern,
  ToolCallDefaultPattern,
  xmlFindPattern
} from '../constants';

describe('Constants', () => {
  test('MASKED_STRING has the correct value', () => {
    expect(MASKED_STRING).toBe('masked:********');
  });

  test('ToolCallDefaultPatternJSON has the correct value', () => {
    expect(ToolCallDefaultPatternJSON).toBe('{"tool": "TOOL_NAME", "parameters": {"PARAM_NAME1":"PARAM_VALUE1$", "$PARAM_NAME2":"$PARAM_VALUE2$", "...": "..." }}');
  });

  test('ToolCallDefaultPatternXML has the correct value', () => {
    expect(ToolCallDefaultPatternXML).toBe('<TOOL_NAME><PARAM_NAME1>PARAM_VALUE1</PARAM_NAME1><PARAM_NAME2>PARAM_VALUE1</PARAM_NAME2></TOOL_NAME>');
  });

  test('ReasoningDefaultPatternJSON has the correct value', () => {
    expect(ReasoningDefaultPatternJSON).toBe('{"think": "THINK_TEXT"}');
  });

  test('ReasoningDefaultPatternXML has the correct value', () => {
    expect(ReasoningDefaultPatternXML).toBe('<THINK>THINK_TEXT</THINK>');
  });

  test('ReasoningDefaultPattern has the correct value', () => {
    expect(ReasoningDefaultPattern).toBe(ReasoningDefaultPatternJSON);
  });

  test('ToolCallDefaultPattern has the correct value', () => {
    expect(ToolCallDefaultPattern).toBe(ToolCallDefaultPatternJSON);
  });

  test('xmlFindPattern has the correct value', () => {
    expect(xmlFindPattern).toBe('<([w-]+)>(?:.+)</({1})>');
  });
}); 