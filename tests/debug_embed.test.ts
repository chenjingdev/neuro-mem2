import { describe, it, expect } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { VectorSearcher, cosineSimilarityVec } from '../src/retrieval/vector-searcher.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';

describe('debug search', () => {
  it('finds the right anchor', async () => {
    const db = createDatabase({ inMemory: true });
    const anchorRepo = new AnchorRepository(db);
    const embeddingProvider = new MockEmbeddingProvider(8);
    
    const tsVec = [1, 0, 0, 0, 0, 0, 0, 0];
    const pyVec = [0, 1, 0, 0, 0, 0, 0, 0];
    
    anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TypeScript programming',
      anchorType: 'topic',
      embedding: new Float32Array(tsVec),
    });
    
    anchorRepo.createAnchor({
      label: 'Python',
      description: 'Python programming',
      anchorType: 'topic',
      embedding: new Float32Array(pyVec),
    });
    
    embeddingProvider.setEmbedding('TypeScript migration', tsVec);
    
    const searcher = new VectorSearcher(db, embeddingProvider, {
      expandToMemoryNodes: false,
      similarityThreshold: 0.1,
    });
    
    const result = await searcher.search('TypeScript migration');
    
    console.log('Items:', result.items.map(i => ({
      nodeId: i.nodeId.slice(0, 8),
      nodeType: i.nodeType,
      score: i.score,
      content: i.content,
    })));
    console.log('Matched anchors:', result.matchedAnchors);
    console.log('Stats:', result.stats);
  });
});
