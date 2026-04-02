-- CreateIndex
CREATE INDEX "contacts_name_idx" ON "contacts"("name");

-- CreateIndex
CREATE INDEX "contacts_email_idx" ON "contacts"("email");

-- CreateIndex
CREATE INDEX "contacts_isVip_idx" ON "contacts"("isVip");

-- CreateIndex
CREATE INDEX "conversations_category_idx" ON "conversations"("category");

-- CreateIndex
CREATE INDEX "conversations_priority_idx" ON "conversations"("priority");

-- CreateIndex
CREATE INDEX "whatsapp_instances_status_idx" ON "whatsapp_instances"("status");
