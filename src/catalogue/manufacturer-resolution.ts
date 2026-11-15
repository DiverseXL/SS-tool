import type { Manufacturer } from '../db/schema.js';
import { normalizeName } from '../lib/normalize.js';
import type { ManufacturerRepository } from '../repositories/manufacturer-repository.js';
import type { ValidatedRow } from './row-validator.js';

export interface ManufacturerResolutionResult {
  manufacturer: Manufacturer;
  /** Non-fatal warnings about conflicting metadata. */
  warnings: string[];
}

/**
 * Resolve or create a manufacturer for a validated row.
 *
 * Rules:
 * - Find by normalised name.
 * - Create when missing.
 * - When found, fill blank website / countryCode with incoming data.
 * - Warn (do NOT overwrite) when existing non-empty data conflicts with incoming data.
 */
export async function resolveManufacturer(
  repo: ManufacturerRepository,
  row: ValidatedRow,
): Promise<ManufacturerResolutionResult> {
  const normalized = normalizeName(row.manufacturer_name);
  const warnings: string[] = [];

  const existing = await repo.findByNormalizedName(normalized);

  if (!existing) {
    const manufacturer = await repo.create({
      name: row.manufacturer_name,
      normalizedName: normalized,
      website: row.manufacturer_website ?? null,
      countryCode: row.manufacturer_country_code ?? null,
    });
    return { manufacturer, warnings };
  }

  // Manufacturer already exists — check for metadata conflicts and fill gaps.
  const updates: Partial<Pick<Manufacturer, 'website' | 'countryCode'>> = {};

  if (row.manufacturer_website) {
    if (!existing.website) {
      updates.website = row.manufacturer_website;
    } else if (existing.website !== row.manufacturer_website) {
      warnings.push(
        `Manufacturer "${existing.name}" already has website "${existing.website}"; ` +
          `incoming value "${row.manufacturer_website}" was ignored.`,
      );
    }
  }

  if (row.manufacturer_country_code) {
    if (!existing.countryCode) {
      updates.countryCode = row.manufacturer_country_code;
    } else if (existing.countryCode !== row.manufacturer_country_code) {
      warnings.push(
        `Manufacturer "${existing.name}" already has countryCode "${existing.countryCode}"; ` +
          `incoming value "${row.manufacturer_country_code}" was ignored.`,
      );
    }
  }

  if (Object.keys(updates).length > 0) {
    const updated = await repo.update(existing.id, updates);
    return { manufacturer: updated, warnings };
  }

  return { manufacturer: existing, warnings };
}

