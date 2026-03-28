-- Convert old ADMIN role to SUPER_ADMIN before schema push
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ADMIN' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'Role')) THEN
    -- Add SUPER_ADMIN if it doesn't exist yet
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SUPER_ADMIN' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'Role')) THEN
      ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';
    END IF;
  END IF;
END $$;

-- Update existing rows
UPDATE users SET role = 'SUPER_ADMIN' WHERE role = 'ADMIN';
