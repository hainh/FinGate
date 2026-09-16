/**
 * @fingate/shared — nguồn dùng chung cho web + api (ADR-09)
 *
 * Không import React ở tầng này (kể cả type) — phần UI nằm ở `@fingate/shared/ui`.
 */

export * from './status/index.js';
export * from './money/index.js';
export * from './errors/index.js';
export * from './permissions/index.js';
export * from './text/index.js';
export * from './contracts/index.js';
