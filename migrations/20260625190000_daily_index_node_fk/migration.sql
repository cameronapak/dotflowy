-- CreateIndex
CREATE INDEX "DailyIndexEntry_nodeId_idx" ON "DailyIndexEntry"("nodeId");

-- AddForeignKey
ALTER TABLE "DailyIndexEntry" ADD CONSTRAINT "DailyIndexEntry_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
