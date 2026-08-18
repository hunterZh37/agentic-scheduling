-- AlterTable
ALTER TABLE "Todo" ADD COLUMN     "recurringTodoId" TEXT;

-- CreateTable
CREATE TABLE "RecurringTodo" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rrule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "startMinutes" INTEGER,
    "endMinutes" INTEGER,
    "location" TEXT,
    "videoLink" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastMaterializedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringTodo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringTodo_active_idx" ON "RecurringTodo"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Todo_recurringTodoId_date_key" ON "Todo"("recurringTodoId", "date");

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_recurringTodoId_fkey" FOREIGN KEY ("recurringTodoId") REFERENCES "RecurringTodo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
