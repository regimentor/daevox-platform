import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const users = sqliteTable('users_table', {
  id: int().primaryKey({ autoIncrement: true }),
  login: text().notNull().unique(),
});

const dialogs = sqliteTable('dialogs_table', {
  id: int().primaryKey({ autoIncrement: true }),
  userId: int().notNull(),
  lastResponseId: text(),
});

export { users, dialogs };
