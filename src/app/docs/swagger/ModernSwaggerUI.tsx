import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Paper,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Tabs,
  Tab,
  Chip,
  TextField,
  Button,
  Divider,
  useTheme,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CodeIcon from "@mui/icons-material/Code";
import HttpIcon from "@mui/icons-material/Http";
import DescriptionIcon from "@mui/icons-material/Description";
import { alpha } from "@mui/material/styles";

// Type definitions for OpenAPI schema
interface OpenAPISchema {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  paths: Record<string, Record<string, PathItem>>;
  tags?: Array<{ name: string; description: string }>;
}

interface PathItem {
  summary: string;
  description: string;
  tags: string[];
  parameters?: any[];
  requestBody?: any;
  responses: Record<string, any>;
}

interface Props {
  url: string;
}

// Component to show a formatted JSON
function JsonViewer({ json }: { json: any }) {
  const theme = useTheme();

  return (
    <Box
      component="pre"
      sx={{
        p: 2,
        borderRadius: 1,
        bgcolor:
          theme.palette.mode === "dark"
            ? "rgba(0,0,0,0.2)"
            : "rgba(0,0,0,0.05)",
        overflow: "auto",
        fontSize: "0.875rem",
        maxHeight: "300px",
      }}
    >
      {JSON.stringify(json, null, 2)}
    </Box>
  );
}

// Safely get color from theme palette or return a default
function getMethodColor(theme: any, method: string): string {
  const methodColorMap: Record<string, string> = {
    get: theme.palette.success.main,
    post: theme.palette.primary.main,
    put: theme.palette.warning.main,
    delete: theme.palette.error.main,
    patch: theme.palette.info.main,
    options: theme.palette.secondary.main,
  };

  return methodColorMap[method] || theme.palette.grey[500];
}

// This is a placeholder for a future implementation
// Currently we're using the suppressStrictModeWarnings approach with the original swagger-ui-react
export default function ModernSwaggerUI({ url }: Props) {
  const [spec, setSpec] = useState<OpenAPISchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  // Fetch the OpenAPI spec
  useEffect(() => {
    fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        setSpec(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [url]);

  // Group endpoints by tag
  const endpointsByTag = React.useMemo(() => {
    if (!spec) return {};

    const grouped: Record<
      string,
      Array<{ path: string; method: string; item: PathItem }>
    > = {};

    Object.entries(spec.paths).forEach(([path, methods]) => {
      Object.entries(methods).forEach(([method, item]) => {
        const tags = item.tags || ["default"];

        tags.forEach((tag) => {
          if (!grouped[tag]) {
            grouped[tag] = [];
          }

          grouped[tag].push({ path, method, item });
        });
      });
    });

    return grouped;
  }, [spec]);

  if (loading) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography>Loading API Documentation...</Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 4, textAlign: "center", color: "error.main" }}>
        <Typography>Error loading API Documentation: {error}</Typography>
      </Box>
    );
  }

  if (!spec) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography>No API specification found</Typography>
      </Box>
    );
  }

  // Color mapping for HTTP methods as MUI color types
  const methodColors: Record<
    string,
    "success" | "primary" | "warning" | "error" | "info" | "secondary"
  > = {
    get: "success",
    post: "primary",
    put: "warning",
    delete: "error",
    patch: "info",
    options: "secondary",
  };

  // For the Button component which doesn't support 'default' color
  const getButtonColor = (
    method: string
  ):
    | "success"
    | "primary"
    | "warning"
    | "error"
    | "info"
    | "secondary"
    | "inherit" => {
    return methodColors[method] || "primary";
  };

  return (
    <Box sx={{ p: 2 }}>
      {Object.entries(endpointsByTag).map(([tag, endpoints]) => (
        <Accordion key={tag} sx={{ mb: 2 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="h6">{tag}</Typography>
            <Chip label={endpoints.length} size="small" sx={{ ml: 2 }} />
          </AccordionSummary>
          <AccordionDetails>
            {endpoints.map(({ path, method, item }) => (
              <Paper
                key={`${path}-${method}`}
                sx={{
                  p: 2,
                  mb: 2,
                  borderLeft: `4px solid ${getMethodColor(theme, method)}`,
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
                  <Chip
                    label={method.toUpperCase()}
                    color={methodColors[method] || "default"}
                    size="small"
                    sx={{ mr: 2 }}
                  />
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontFamily: "monospace",
                      fontWeight: "bold",
                    }}
                  >
                    {path}
                  </Typography>
                </Box>

                <Typography variant="body2" sx={{ mb: 2 }}>
                  {item.description ||
                    item.summary ||
                    "No description available."}
                </Typography>

                <Tabs value={0}>
                  <Tab icon={<HttpIcon />} label="TRY" />
                  <Tab icon={<DescriptionIcon />} label="DOCS" />
                  <Tab icon={<CodeIcon />} label="SCHEMA" />
                </Tabs>

                <Divider sx={{ my: 2 }} />

                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>
                    Parameters
                  </Typography>
                  {item.parameters && item.parameters.length > 0 ? (
                    item.parameters.map((param: any, index: number) => (
                      <Box key={index} sx={{ mb: 2 }}>
                        <TextField
                          label={
                            <Box sx={{ display: "flex", alignItems: "center" }}>
                              {param.name}
                              {param.required && (
                                <Box
                                  component="span"
                                  sx={{
                                    color: "error.main",
                                    ml: 0.5,
                                    fontSize: "18px",
                                    fontWeight: "bold",
                                  }}
                                >
                                  *
                                </Box>
                              )}
                              <Chip
                                label={param.in}
                                size="small"
                                variant="outlined"
                                sx={{ ml: 1, height: 20, fontSize: "0.7rem" }}
                              />
                            </Box>
                          }
                          size="small"
                          fullWidth
                          required={param.required}
                          helperText={param.description}
                          placeholder={param.schema?.example || ""}
                          InputProps={{
                            sx: {
                              borderRadius: "8px",
                              ...(param.required && {
                                "& .MuiOutlinedInput-notchedOutline": {
                                  borderColor: (theme) =>
                                    alpha(theme.palette.error.main, 0.5),
                                },
                                "&:hover .MuiOutlinedInput-notchedOutline": {
                                  borderColor: "error.main",
                                },
                              }),
                            },
                          }}
                        />
                      </Box>
                    ))
                  ) : (
                    <Typography variant="body2">No parameters</Typography>
                  )}

                  {item.requestBody && (
                    <>
                      <Typography variant="subtitle2" sx={{ mb: 1, mt: 2 }}>
                        Request Body
                      </Typography>
                      <JsonViewer
                        json={
                          item.requestBody.content?.["application/json"]
                            ?.schema || {}
                        }
                      />
                    </>
                  )}

                  <Button
                    variant="contained"
                    color={getButtonColor(method)}
                    sx={{ mt: 2 }}
                  >
                    Execute
                  </Button>

                  <Typography variant="subtitle2" sx={{ mb: 1, mt: 3 }}>
                    Responses
                  </Typography>
                  {Object.entries(item.responses).map(
                    ([code, response]: [string, any]) => (
                      <Accordion key={code} sx={{ mb: 1 }}>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                          <Chip
                            label={code}
                            color={
                              code.startsWith("2")
                                ? "success"
                                : code.startsWith("4")
                                ? "error"
                                : "warning"
                            }
                            size="small"
                            sx={{ mr: 2 }}
                          />
                          <Typography>{response.description}</Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                          {response.content?.["application/json"]?.schema && (
                            <JsonViewer
                              json={response.content["application/json"].schema}
                            />
                          )}
                        </AccordionDetails>
                      </Accordion>
                    )
                  )}
                </Box>
              </Paper>
            ))}
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}
