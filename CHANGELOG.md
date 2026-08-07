# Changelog

## [Unreleased]

### Fixed
- OpenRouter multimodal chat models (e.g. `outputModalities: ["text","image"]`) were routed to the
  dedicated `/images` / `/videos` media endpoints and failed with a route-not-found error even for
  plain text turns (#370). Routing to the dedicated media route is now reserved for models that are
  media-only (image/video output without text), via a single shared `resolveOpenRouterMediaRoute`
  helper used by both execution and the model-card test.

### Added
- The model card "Test" dialog now shows which adapter/endpoint the flow engine actually resolves
  for a model (`Adapter used by flows`) and exercises that exact adapter, so a green test result now
  matches real chat behaviour.
- OpenRouter media adapter errors are now mapped to an actionable message naming the model and
  endpoint when a dedicated media route genuinely 404s.

## [0.1.3] - 2025-04-07

### Added
- Handoff tools in flowbuilder for improved flow control
- Agent Tools tab in Process Node properties modal
- Message editing functionality in chat interface
- Background execution capabilities for improved performance
- FlujoChatMessage Type for better internal message handling
- Debugging capabilities with step-by-step execution (disabled until ready)
- DebuggerCanvas component for visualizing flow execution (disabled until ready)

### Fixed
- Timestamp validation and handling issues
- Improved error handling in flow execution
- Enhanced logging for better debugging
- Fixed issues with handoff tool generation in ProcessNode

### Changed
- Refactored ProcessNodePropertiesModal for better organization
- Updated UI styling for handoff tools
- Improved API response handling

## [0.1.2] - 2025-03-14

- Flowbuilder UI Rework
- React Re-Rendering Issues
- better stop_reason handling
- better chat experience

## [0.1.1] - Initial Release
