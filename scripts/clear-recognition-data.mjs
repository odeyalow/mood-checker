import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const [recognitions, snapshots] = await prisma.$transaction([
    prisma.recognition.deleteMany({}),
    prisma.emotionSnapshot.deleteMany({}),
  ]);

  console.log("Recognition data cleared.");
  console.log(`Deleted recognitions: ${recognitions.count}`);
  console.log(`Deleted emotion snapshots: ${snapshots.count}`);
  console.log("Users were not touched.");
} catch (error) {
  console.error("Failed to clear recognition data:", error.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
