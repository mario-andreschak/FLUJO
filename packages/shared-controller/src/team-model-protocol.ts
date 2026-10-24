/** Node ESM entry point. App/browser consumers use shared-model directly. */
export {
  teamResourceId, teamModelGeneration, teamModelReferenceSchema,
  teamModelSummarySchema, teamModelCatalogueSchema, resolvedTeamModelSchema,
  teamModelId, parseTeamModelId, teamModelBaseUrl,
  type TeamModelReference,
} from './shared-model.js';
