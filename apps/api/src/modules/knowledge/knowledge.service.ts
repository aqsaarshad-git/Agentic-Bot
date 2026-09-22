import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateKnowledgeDocumentDto } from './dto/create-knowledge-document.dto';
import { UpdateKnowledgeDocumentDto } from './dto/update-knowledge-document.dto';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'and', 'or', 'in', 'on',
  'for', 'with', 'my', 'your', 'i', 'you', 'it', 'this', 'that', 'do', 'does', 'did', 'can', 'how',
  'what', 'why', 'when', 'me', 'we', 'our', 'have', 'has', 'had',
]);

/**
 * Retrieval is plain keyword overlap for now — there's no embedding provider in the
 * mandated stack (Qwen is the chat LLM, Cohere's role here is Arabic STT). Kept behind
 * this service so it can be swapped for real vector search later without touching the
 * orchestrator, which only calls `searchRelevant`.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  private chunkContent(content: string): string[] {
    const paragraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    const chunks: string[] = [];
    for (const paragraph of paragraphs) {
      if (paragraph.length <= 800) {
        chunks.push(paragraph);
        continue;
      }
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      let current = '';
      for (const sentence of sentences) {
        if ((current + ' ' + sentence).trim().length > 500 && current) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current = (current + ' ' + sentence).trim();
        }
      }
      if (current) chunks.push(current.trim());
    }
    return chunks.length > 0 ? chunks : [content.trim()];
  }

  private async writeChunks(documentId: string, content: string) {
    await this.prisma.knowledgeChunk.deleteMany({ where: { documentId } });
    const chunks = this.chunkContent(content);
    await this.prisma.knowledgeChunk.createMany({
      data: chunks.map((text, index) => ({
        documentId,
        content: text,
        chunkIndex: index,
        embedding: [],
      })),
    });
  }

  async create(dto: CreateKnowledgeDocumentDto) {
    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        title: dto.title,
        category: dto.category,
        content: dto.content,
        status: dto.status ?? 'DRAFT',
      },
    });
    await this.writeChunks(doc.id, dto.content);
    return doc;
  }

  findAll() {
    return this.prisma.knowledgeDocument.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async findOne(id: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({
      where: { id },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!doc) throw new NotFoundException(`Knowledge document ${id} not found`);
    return doc;
  }

  async update(id: string, dto: UpdateKnowledgeDocumentDto) {
    await this.findOne(id);
    const updated = await this.prisma.knowledgeDocument.update({
      where: { id },
      data: { title: dto.title, category: dto.category, content: dto.content, status: dto.status },
    });
    if (dto.content) {
      await this.writeChunks(id, dto.content);
    }
    return updated;
  }

  /** Top-N published chunks whose text best overlaps the query's significant words. */
  async searchRelevant(query: string, limit = 3): Promise<{ documentTitle: string; content: string }[]> {
    const words = Array.from(
      new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9؀-ۿ]+/)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      ),
    );
    if (words.length === 0) return [];

    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: { document: { status: 'PUBLISHED' } },
      include: { document: { select: { title: true } } },
    });

    const scored = chunks
      .map((chunk) => {
        const lower = chunk.content.toLowerCase();
        const score = words.reduce((sum, w) => sum + (lower.includes(w) ? 1 : 0), 0);
        return { chunk, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => ({ documentTitle: s.chunk.document.title, content: s.chunk.content }));
  }
}
