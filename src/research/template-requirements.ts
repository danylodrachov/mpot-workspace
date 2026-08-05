import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface TemplateColumn {
  name: string;
  type: "text" | "enum" | "number";
  values?: string[];
}

export interface Template {
  columns: TemplateColumn[];
  operator_fields?: string[];
  category: string;
}

export interface FieldRequirement {
  field_id: string;
  category: string;
  name: string;
  type: string;
  dropdown_dependency?: string;
  normalization_target?: string;
  evidence_shape?: string;
  completeness_dimensions?: string[];
  extraction_rule_ids?: string[];
  page_class_hints?: string[];
  terminal_missing_statuses?: string[];
}

export interface FieldRequirementsOutput {
  fields: FieldRequirement[];
  version: string;
}

export interface DropdownCatalogEntry {
  canonical: string;
  aliases: string[];
  type: string;
  source_hash: string;
}

export interface DropdownCatalogOutput {
  dropdowns: Record<string, DropdownCatalogEntry[]>;
  version: string;
}

export async function compileTemplateRequirements(
  templatesDir: string,
  outputDir: string
): Promise<void> {
  try {
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Load all templates
    const templates = loadTemplates(templatesDir);

    // Load dropdowns
    const dropdowns = loadDropdowns(templatesDir);

    // Compile field requirements
    const fieldRequirements = compileFieldRequirements(templates);

    // Compile dropdown catalog
    const dropdownCatalog = compileDropdownCatalog(dropdowns);

    const fieldReqOutput: FieldRequirementsOutput = {
      fields: fieldRequirements,
      version: "1.0.0",
    };

    const dropdownOutput: DropdownCatalogOutput = {
      dropdowns: dropdownCatalog,
      version: "1.0.0",
    };

    // Write atomically with sorted JSON for deterministic output
    const fieldReqPath = path.join(outputDir, "field-requirements.json");
    const dropdownPath = path.join(outputDir, "dropdown-catalog.json");

    const fieldReqContent = JSON.stringify(fieldReqOutput, null, 2) + "\n";
    const dropdownContent = JSON.stringify(dropdownOutput, null, 2) + "\n";

    // Write both files
    await fs.promises.writeFile(fieldReqPath, fieldReqContent, "utf-8");
    await fs.promises.writeFile(dropdownPath, dropdownContent, "utf-8");
  } catch (error) {
    throw error;
  }
}

function loadTemplates(templatesDir: string): Template[] {
  const templates: Template[] = [];
  const files = fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith(".json") && f !== "dropdowns.json")
    .sort();

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    try {
      const template = JSON.parse(content) as Template;

      // Validate template structure
      if (!template.columns || !Array.isArray(template.columns)) {
        throw new Error(`Template ${file} missing 'columns' array`);
      }

      if (!template.category || typeof template.category !== "string") {
        throw new Error(`Template ${file} missing 'category' field`);
      }

      templates.push(template);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in template ${file}: ${error.message}`);
      }
      throw error;
    }
  }

  return templates;
}

function loadDropdowns(
  templatesDir: string
): Record<string, (string | boolean | number)[]> {
  const dropdownPath = path.join(templatesDir, "dropdowns.json");
  const content = fs.readFileSync(dropdownPath, "utf-8");

  try {
    const dropdowns = JSON.parse(
      content
    ) as Record<string, (string | boolean | number)[]>;

    // Validate dropdowns structure
    for (const [key, values] of Object.entries(dropdowns)) {
      if (!Array.isArray(values)) {
        throw new Error(`Dropdown '${key}' is not an array`);
      }

      for (const val of values) {
        const type = typeof val;
        if (type !== "string" && type !== "boolean" && type !== "number") {
          throw new Error(
            `Dropdown '${key}' contains value of invalid type '${type}'`
          );
        }
      }
    }

    return dropdowns;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in dropdowns.json: ${error.message}`);
    }
    throw error;
  }
}

function compileFieldRequirements(templates: Template[]): FieldRequirement[] {
  const fields: FieldRequirement[] = [];

  for (const template of templates) {
    const operatorFields = new Set(template.operator_fields || []);

    // Sort columns by name for stable ordering
    const sortedColumns = [...template.columns].sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const column of sortedColumns) {
      // Skip operator fields
      if (operatorFields.has(column.name)) {
        continue;
      }

      // Generate stable field ID
      const fieldId = generateFieldId(template.category, column.name);

      const field: FieldRequirement = {
        field_id: fieldId,
        category: template.category,
        name: column.name,
        type: column.type,
      };

      // Add enum values as dropdown dependency if present
      if (column.type === "enum" && column.values) {
        field.dropdown_dependency = column.values.join(",");
      }

      fields.push(field);
    }
  }

  // Sort fields by field_id for stable output
  fields.sort((a, b) => a.field_id.localeCompare(b.field_id));

  return fields;
}

function compileDropdownCatalog(
  dropdowns: Record<string, (string | boolean | number)[]>
): Record<string, DropdownCatalogEntry[]> {
  const catalog: Record<string, DropdownCatalogEntry[]> = {};

  for (const [key, values] of Object.entries(dropdowns)) {
    // Deduplicate while preserving canonical (first occurrence)
    const seen = new Set<string>();
    const entries: DropdownCatalogEntry[] = [];

    for (const value of values) {
      // Convert value to string for deduplication key
      const valueStr = String(value);

      if (!seen.has(valueStr)) {
        seen.add(valueStr);

        // Determine type
        let valueType = "string";
        if (typeof value === "boolean") {
          valueType = "boolean";
        } else if (typeof value === "number") {
          valueType = "number";
        }

        // Create catalog entry
        const entry: DropdownCatalogEntry = {
          canonical: valueStr,
          aliases: [], // First implementation has no aliases
          type: valueType,
          source_hash: hashValue(valueStr),
        };

        entries.push(entry);
      }
    }

    // Sort by canonical for stable output
    entries.sort((a, b) => a.canonical.localeCompare(b.canonical));

    catalog[key] = entries;
  }

  return catalog;
}

function generateFieldId(category: string, fieldName: string): string {
  // Create stable field ID from category and field name
  return `${category}:${fieldName}`;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
