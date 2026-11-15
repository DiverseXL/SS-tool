import type { Manufacturer } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { normalizeName } from '../lib/normalize.js';
import type { ManufacturerRepository } from '../repositories/manufacturer-repository.js';

export interface CreateManufacturerInput {
  name: string;
  website?: string | undefined;
  countryCode?: string | undefined;
}

export interface ManufacturerService {
  create(input: CreateManufacturerInput): Promise<Manufacturer>;
  getById(id: string): Promise<Manufacturer>;
  list(): Promise<Manufacturer[]>;
}

export function createManufacturerService(repository: ManufacturerRepository): ManufacturerService {
  return {
    async create(input) {
      const normalizedName = normalizeName(input.name);

      const existing = await repository.findByNormalizedName(normalizedName);
      if (existing) {
        throw AppError.conflict('DUPLICATE_MANUFACTURER', 'A manufacturer with this name already exists');
      }

      try {
        return await repository.create({
          name: input.name.trim(),
          normalizedName,
          website: input.website ?? null,
          countryCode: input.countryCode ?? null,
        });
      } catch (error) {
        // Covers the race between the check above and the insert.
        if (error instanceof AppError && error.statusCode === 409) {
          throw AppError.conflict('DUPLICATE_MANUFACTURER', 'A manufacturer with this name already exists');
        }
        throw error;
      }
    },

    async getById(id) {
      const manufacturer = await repository.findById(id);
      if (!manufacturer) {
        throw AppError.notFound('MANUFACTURER_NOT_FOUND', 'Manufacturer not found');
      }
      return manufacturer;
    },

    async list() {
      return repository.list();
    },
  };
}
