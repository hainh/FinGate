/** Kết nối + chỉ số lúc boot (architecture §6, §8.6). */

export { connectDb, disconnectDb, dbUp, dbName } from '../lib/mongo.ts';
export { applyIndexes, applyValidators } from './indexes.ts';
