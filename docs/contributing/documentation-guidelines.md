# Documentation Guidelines

This document provides guidelines for contributing to the Flujo documentation, with specific guidance for AI assistants and human contributors.

## Documentation Structure

The Flujo documentation follows a hierarchical structure:

```
docs/
├── README.md                      # Main documentation entry point
├── getting-started/               # Quick start guides and installation
├── features/                      # Feature documentation
│   ├── README.md                  # Features overview
│   ├── mcp/                       # MCP-related features
│   │   ├── docker-servers.md      # Docker-based MCP servers
│   │   └── ...
│   ├── flows/                     # Flow-related features
│   └── ...
├── architecture/                  # Technical architecture
├── contributing/                  # Contribution guidelines
│   └── documentation-guidelines.md # This file
└── api-reference/                 # API documentation
```

## Writing Style

### General Guidelines

1. **User-focused**: Focus on the user experience rather than technical implementation details
2. **Clear and concise**: Use simple language and avoid jargon
3. **Task-oriented**: Organize content around tasks users want to accomplish
4. **Consistent terminology**: Use consistent terms throughout the documentation

### Formatting

- Use Markdown for all documentation
- Use heading levels (H1, H2, H3) to create a clear hierarchy
- Use code blocks for code examples, configuration snippets, and terminal commands
- Use numbered lists for sequential steps
- Use bullet points for non-sequential items
- Use tables for structured data

## Document Structure

Each document should follow this general structure:

1. **Title**: Clear, descriptive title (H1)
2. **Overview**: Brief introduction to the topic
3. **Main content**: Detailed information organized into logical sections
4. **Examples**: Practical examples of the feature in use
5. **Troubleshooting** (if applicable): Common issues and solutions

## Guidelines for AI Assistants

When contributing to documentation as an AI assistant:

1. **Focus on user experience**: Describe how users interact with features rather than implementation details
2. **Provide clear steps**: Break down processes into clear, numbered steps
3. **Include examples**: Provide practical examples that users can follow
4. **Anticipate questions**: Address common questions and potential points of confusion
5. **Use consistent terminology**: Align with existing documentation terminology
6. **Maintain structure**: Follow the established documentation structure
7. **Include troubleshooting**: Anticipate common issues and provide solutions

## Documentation Review Process

All documentation contributions should be reviewed for:

1. **Accuracy**: Is the information correct and up-to-date?
2. **Clarity**: Is the content clear and easy to understand?
3. **Completeness**: Does it cover all necessary aspects of the topic?
4. **Consistency**: Does it follow the established style and structure?
5. **User focus**: Is it written from the user's perspective?

## Creating New Documentation

When creating documentation for a new feature:

1. Identify where it fits in the existing structure
2. Create a new file in the appropriate directory
3. Follow the document structure outlined above
4. Link to the new document from relevant overview pages
5. Submit the documentation for review

## Updating Existing Documentation

When updating existing documentation:

1. Maintain the established structure and style
2. Update all affected sections for consistency
3. Verify that links and references remain valid
4. Note significant changes in the commit message
