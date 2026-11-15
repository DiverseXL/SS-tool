import type { Product } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { normalizeModelIdentifier } from '../lib/normalize.js';
import { buildPagination, type PaginationMeta } from '../lib/pagination.js';
import type { ManufacturerRepository } from '../repositories/manufacturer-repository.js';
import type { ProductRepository, ProductWithManufacturer } from '../repositories/product-repository.js';

export interface CreateProductInput {
  manufacturerId: string;
  name: string;
  modelIdentifier?: string | undefined;
  gtin?: string | undefined;
  sku?: string | undefined;
  category?: string | undefined;
  productUrl?: string | undefined;
  marketRegion?: string | undefined;
}

export interface ListProductsInput {
  page: number;
  pageSize: number;
  manufacturerId?: string | undefined;
}

export interface ProductListResult {
  items: Product[];
  pagination: PaginationMeta;
}

export interface ProductService {
  create(input: CreateProductInput): Promise<Product>;
  getById(id: string): Promise<ProductWithManufacturer>;
  list(input: ListProductsInput): Promise<ProductListResult>;
}

export function createProductService(
  products: ProductRepository,
  manufacturers: ManufacturerRepository,
): ProductService {
  return {
    async create(input) {
      const manufacturer = await manufacturers.findById(input.manufacturerId);
      if (!manufacturer) {
        throw AppError.notFound('MANUFACTURER_NOT_FOUND', 'Manufacturer not found');
      }

      const modelIdentifier = input.modelIdentifier
        ? normalizeModelIdentifier(input.modelIdentifier)
        : undefined;

      if (modelIdentifier) {
        const existing = await products.findByManufacturerAndModel(
          input.manufacturerId,
          modelIdentifier,
        );
        if (existing) {
          throw AppError.conflict(
            'DUPLICATE_PRODUCT',
            'A product with this model identifier already exists for this manufacturer',
          );
        }
      }

      try {
        return await products.create({
          manufacturerId: input.manufacturerId,
          name: input.name.trim(),
          modelIdentifier: modelIdentifier ?? null,
          gtin: input.gtin ?? null,
          sku: input.sku ?? null,
          category: input.category ?? null,
          productUrl: input.productUrl ?? null,
          marketRegion: input.marketRegion ?? null,
        });
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
          throw AppError.conflict(
            'DUPLICATE_PRODUCT',
            'A product with this model identifier already exists for this manufacturer',
          );
        }
        throw error;
      }
    },

    async getById(id) {
      const detail = await products.findDetailById(id);
      if (!detail) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }
      return detail;
    },

    async list(input) {
      const { items, total } = await products.list(input);
      return {
        items,
        pagination: buildPagination(input.page, input.pageSize, total),
      };
    },
  };
}
