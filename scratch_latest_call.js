const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const call = await prisma.call.findFirst({
    orderBy: { startTime: 'desc' },
    include: { conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } } },
  });
  console.log(JSON.stringify(call, null, 2));
  await prisma.$disconnect();
})();
