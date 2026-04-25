// Type declaration for optional peer dependency ioredis.
// The RedisConversationStore lazy-loads ioredis at runtime and provides
// a clear error message if it's not installed.
declare module 'ioredis' {
  class Redis {
    constructor(url: string, options?: Record<string, any>);
    constructor(options?: Record<string, any>);
    connect(): Promise<void>;
    setex(key: string, ttl: number, value: string): Promise<string>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
    quit(): Promise<string>;
  }
  export default Redis;
}
