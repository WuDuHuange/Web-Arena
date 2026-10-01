import type { Entity, EntityId, WorldSnapshot } from "./types.ts";

/**
 * Flat, insertion-ordered entity store.
 *
 * Deliberately not a heavy ECS framework: components live directly on the entity and
 * systems are plain functions over `all()`. Stable iteration order matters, because
 * physics bodies are created in this order and reproducible battles depend on it.
 */
export class World {
  private readonly entities = new Map<EntityId, Entity>();
  private readonly order: EntityId[] = [];
  private nextId = 1;

  /** Adds an entity and returns it with its assigned id. */
  add(input: Omit<Entity, "id">): Entity {
    const id = this.nextId;
    this.nextId += 1;
    const entity: Entity = { id, ...input };
    this.entities.set(id, entity);
    this.order.push(id);
    return entity;
  }

  remove(id: EntityId): boolean {
    if (!this.entities.delete(id)) {
      return false;
    }
    const index = this.order.indexOf(id);
    if (index >= 0) {
      this.order.splice(index, 1);
    }
    return true;
  }

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  /** All entities in insertion order. */
  all(): readonly Entity[] {
    const out: Entity[] = [];
    for (const id of this.order) {
      const entity = this.entities.get(id);
      if (entity) {
        out.push(entity);
      }
    }
    return out;
  }

  get size(): number {
    return this.entities.size;
  }

  snapshot(tick: number): WorldSnapshot {
    return { tick, entities: this.all() };
  }
}
