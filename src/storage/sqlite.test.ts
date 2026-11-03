import { describeDatabase } from "./conformance.ts";
import { SqliteDatabase } from "./sqlite.ts";

describeDatabase("sqlite", () => new SqliteDatabase({ filename: ":memory:" }));
