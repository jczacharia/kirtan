import {
  IDomainModel,
  IPaginate,
  IParser,
  IQuery,
  KIRTAN_LIMIT,
  KIRTAN_PAGE,
  KIRTAN_PAGINATE,
  parseKirtanQuery,
} from '@kirtan/common';
import { paginate, Pagination } from 'nestjs-typeorm-paginate';
import { Socket } from 'socket.io';
import { DeepPartial, FindManyOptions, Repository } from 'typeorm';
import { createTypeormRelationsArray } from './relations.transform';
import { SubscriptionStorage } from './subscription-storage';

/**
 * TODO
 */
export abstract class IKirtanTypeormRepository<
  // eslint-disable-next-line @typescript-eslint/ban-types
  Entity extends IDomainModel<{ id: IdType }, {}>,
  IdType extends string | number = string
> {
  private readonly subscriptionStorage = new SubscriptionStorage<Entity, IdType>();

  readonly subscriptions = {
    oneEntitySubscription: async <Q extends IQuery<Entity>>(
      socket: Socket,
      channel: string,
      id: IdType,
      query: Q
    ) => {
      const listener = () => {
        const relations = createTypeormRelationsArray<Entity>(query);
        return this.repo.findOneOrFail(id, { relations });
      };
      return this.subscriptionStorage.provisionIdsSubscription({ socket, channel, listener, query });
    },

    manyEntitiesSubscription: async <Q extends IQuery<Entity>>(
      socket: Socket,
      channel: string,
      ids: IdType[],
      query: Q
    ) => {
      const listener = () => {
        const relations = createTypeormRelationsArray<Entity>(query);
        return this.repo.findByIds(ids, { relations });
      };
      return this.subscriptionStorage.provisionIdsSubscription({ socket, channel, listener, query });
    },

    querySubscription: async <Q extends IQuery<Entity>>(
      socket: Socket,
      channel: string,
      query: Q,
      options?: Omit<FindManyOptions<Entity>, 'relations'>
    ) => {
      const listener = async () => this.provisionQuery(query, options);
      return this.subscriptionStorage.provisionQuerySubscription({ socket, channel, listener, query });
    },

    onDisconnect: (socket: Socket) => {
      return this.subscriptionStorage.removeListener(socket);
    },
  };

  constructor(
    /** Note: Calling mutating functions here will not trigger repo subscribers. */
    protected readonly repo: Repository<Entity>
  ) {}

  async findOneOrFail<Q extends IQuery<Entity>>(id: IdType, query: Q): Promise<IParser<Entity, Q>> {
    const relations = createTypeormRelationsArray<Entity>(query);
    const dbRes = await this.repo.findOneOrFail(id, { relations });
    return parseKirtanQuery(query, dbRes);
  }

  async findOne<Q extends IQuery<Entity>>(id: IdType, query: Q): Promise<IParser<Entity, Q> | undefined> {
    const relations = createTypeormRelationsArray<Entity>(query);
    const dbRes = await this.repo.findOne(id, { relations });
    return parseKirtanQuery(query, dbRes) as IParser<Entity, Q> | undefined;
  }

  async findMany<Q extends IQuery<Entity>>(ids: IdType[], query: Q): Promise<IParser<Entity[], Q>> {
    if (ids.length === 0) return ([] as unknown) as IParser<Entity[], Q>;
    const relations = createTypeormRelationsArray<Entity>(query);
    const dbRes = await this.repo.findByIds(ids, { relations });
    return parseKirtanQuery(query, dbRes);
  }

  async findAll<Q extends IQuery<Entity>>(query: Q): Promise<IParser<Entity[], Q>> {
    const relations = createTypeormRelationsArray<Entity>(query);
    const dbRes = await this.repo.find({ relations });
    return parseKirtanQuery(query, dbRes);
  }

  async query<Q extends IQuery<Entity>>(
    query: Q,
    options?: Omit<FindManyOptions<Entity>, 'relations'>
  ): Promise<IParser<Entity[], Q>> {
    const entities = await this.provisionQuery(query, options);
    return parseKirtanQuery(query, entities) as IParser<Entity[], Q>;
  }

  private async provisionQuery<Q extends IQuery<Entity>>(
    query: Q,
    options?: Omit<FindManyOptions<Entity>, 'relations'>
  ) {
    let entities: Pagination<Entity> | Entity[];
    const relations = createTypeormRelationsArray<Entity>(query);

    const paginateOptions = (query as IPaginate)[KIRTAN_PAGINATE];
    if (paginateOptions) {
      entities = await paginate(
        this.repo,
        { page: paginateOptions[KIRTAN_PAGE], limit: paginateOptions[KIRTAN_LIMIT] },
        { ...options, relations }
      );
    } else {
      entities = await this.repo.find({ ...options, relations });
    }
    return entities;
  }

  async upsert<Q extends IQuery<Entity>>(entity: Entity, query: Q): Promise<IParser<Entity, Q>> {
    const res = await this.repo.save((entity as unknown) as DeepPartial<Entity>);
    this.subscriptionStorage.trigger(entity.id);
    return this.findOneOrFail(res.id, query);
  }

  async upsertMany<Q extends IQuery<Entity>>(entities: Entity[], query: Q): Promise<IParser<Entity[], Q>> {
    if (entities.length === 0) return ([] as unknown) as IParser<Entity[], Q>;
    await this.repo.save((entities as unknown) as DeepPartial<Entity>[]);
    const ids = entities.map((e) => e.id);
    this.subscriptionStorage.trigger(ids);
    return this.findMany(ids, query);
  }

  async delete(id: IdType): Promise<IdType> {
    await this.repo.delete(id);
    this.subscriptionStorage.trigger(id);
    return id;
  }

  async deleteMany(ids: IdType[]): Promise<IdType[]> {
    if (ids.length === 0) return [];
    await this.repo.delete(ids as string[]);
    this.subscriptionStorage.trigger(ids);
    return ids;
  }
}
