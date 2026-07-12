import type { Options, SearchOptions } from "minisearch";

export const DOC_INDEX_OPTIONS: Options = {
  fields: ["title", "body", "api_names", "synonyms"],
  storeFields: ["title", "body", "api_names", "synonyms"],
  idField: "section_id",
};

export const DOC_SEARCH_OPTIONS: SearchOptions = {
  boost: { api_names: 6, title: 4, synonyms: 2 },
  fuzzy: 0.2,
  prefix: true,
};
