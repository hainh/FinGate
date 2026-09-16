/**
 * Augmentation cho @fastify/swagger: `tags` nằm trong `schema` nhưng FastifySchema
 * mặc định không khai báo khoá đó.
 */

import 'fastify';

declare module 'fastify' {
  interface FastifySchema {
    tags?: string[];
    summary?: string;
    description?: string;
  }
}
