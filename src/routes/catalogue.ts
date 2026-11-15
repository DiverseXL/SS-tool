import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import type { ManufacturerRepository } from '../repositories/manufacturer-repository.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import { importCatalogueFromBuffer } from '../catalogue/import-service.js';
import {
  CsvStructureError,
  MissingRequiredHeadersError,
} from '../catalogue/csv-parser.js';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

interface CatalogueRoutesOptions {
  manufacturerRepository: ManufacturerRepository;
  productRepository: ProductRepository;
}

export const catalogueRoutes: FastifyPluginAsync<CatalogueRoutesOptions> = async (
  app,
  options,
) => {
  const { manufacturerRepository, productRepository } = options;

  // Register multipart support scoped to this plugin instance.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
      files: 1,
    },
  });

  /**
   * POST /api/v1/catalogue/imports
   *
   * Accept a multipart/form-data request with a single CSV file in the `file`
   * field. Parse, validate and import the catalogue rows, returning a detailed
   * per-row result.
   */
  app.post('/api/v1/catalogue/imports', async (request, reply) => {
    // Retrieve the uploaded file part.
    let filePart: Awaited<ReturnType<typeof request.file>>;

    try {
      filePart = await request.file({ limits: { fileSize: MAX_FILE_SIZE_BYTES } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('File size limit') || message.includes('request file')) {
        return reply.code(413).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: `Upload exceeds the maximum file size of 5 MB`,
          },
        });
      }
      throw err;
    }

    if (!filePart) {
      return reply.code(400).send({
        error: {
          code: 'NO_FILE',
          message: 'No file was uploaded. Send a CSV file in the "file" form field.',
        },
      });
    }

    // Validate MIME / field name.
    if (filePart.fieldname !== 'file') {
      await filePart.toBuffer();
      return reply.code(400).send({
        error: {
          code: 'WRONG_FIELD_NAME',
          message: 'File must be uploaded with the form field name "file".',
        },
      });
    }

    // Read file into memory — do NOT persist to disk.
    let buffer: Buffer;
    try {
      buffer = await filePart.toBuffer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('File size limit')) {
        return reply.code(413).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: `Upload exceeds the maximum file size of 5 MB`,
          },
        });
      }
      throw err;
    }

    const mime = filePart.mimetype ?? '';
    const isTextOrCsv =
      mime.startsWith('text/') ||
      mime.includes('csv') ||
      mime === 'application/octet-stream' ||
      mime === 'application/vnd.ms-excel';
    if (!isTextOrCsv) {
      return reply.code(415).send({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Expected a CSV file; received "${mime}".`,
        },
      });
    }

    request.log.info(
      { filename: filePart.filename, sizeBytes: buffer.length },
      'processing catalogue import',
    );

    try {
      const result = await importCatalogueFromBuffer(
        manufacturerRepository,
        productRepository,
        buffer,
      );
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof MissingRequiredHeadersError) {
        return reply.code(422).send({
          error: {
            code: 'MISSING_REQUIRED_HEADERS',
            message: err.message,
            details: err.missingHeaders.map((h) => ({ field: h, message: 'Header is required' })),
          },
        });
      }

      if (err instanceof CsvStructureError) {
        return reply.code(422).send({
          error: {
            code: 'INVALID_CSV',
            message: err.message,
          },
        });
      }

      throw err;
    }
  });
};

