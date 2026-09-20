import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import mongoose, { type Connection, type Model } from 'mongoose';

import type { CloudConfig } from '../config.js';
import { modelDefinitions } from './schemas.js';

export const CLOUD_CONFIG = Symbol('CLOUD_CONFIG');

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  #connection: Connection | undefined;
  readonly #config: CloudConfig;

  constructor(@Inject(CLOUD_CONFIG) config: CloudConfig) {
    this.#config = config;
  }

  async onModuleInit(): Promise<void> {
    const connection = mongoose.createConnection(this.#config.mongodbUri, {
      dbName: this.#config.mongodbDatabase,
      autoIndex: this.#config.nodeEnv !== 'production',
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();
    for (const [name, schema, collection] of modelDefinitions) connection.model(name, schema, collection);
    this.#connection = connection;
  }

  model<T>(name: string): Model<T> {
    if (!this.#connection) throw new Error('MongoDB is not connected.');
    return this.#connection.model<T>(name);
  }

  async transaction<T>(operation: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
    if (!this.#connection) throw new Error('MongoDB is not connected.');
    const session = await this.#connection.startSession();
    try {
      return await session.withTransaction(() => operation(session));
    } finally {
      await session.endSession();
    }
  }

  async syncIndexes(): Promise<void> {
    if (!this.#connection) throw new Error('MongoDB is not connected.');
    for (const [name] of modelDefinitions) await this.#connection.model(name).syncIndexes();
  }

  async onModuleDestroy(): Promise<void> {
    await this.#connection?.close();
    this.#connection = undefined;
  }
}
