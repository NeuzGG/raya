import { EventEmitter } from 'node:events';

type EventMap = { [event: string]: unknown[] };

/**
 * EventEmitter with fully typed event names and listener arguments.
 */
export class TypedEmitter<Events extends EventMap> extends EventEmitter {
  public override on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  public override once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  public override off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  public override emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }
}
