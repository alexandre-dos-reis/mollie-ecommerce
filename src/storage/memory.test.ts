import { describeDatabase } from "./conformance.ts";
import { InMemoryDatabase } from "./memory.ts";

describeDatabase("memory", () => new InMemoryDatabase());
