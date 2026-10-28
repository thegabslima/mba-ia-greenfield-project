import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { TEN_GIGABYTES_IN_BYTES } from '../src/config/storage.config';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { clearMailpitMessages } from '../src/test/mailpit';
import { VideoStatus } from '../src/videos/entities/video.entity';

const execFileAsync = promisify(execFile);

function binaryParser(
  res: any,
  callback: (err: Error | null, body: any) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  res.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
  res.on('error', (err: Error) => {
    callback(err, Buffer.alloc(0));
  });
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authService: AuthService;
  let storageService: StorageService;
  let throttlerStorage: Record<string, unknown>;
  let sampleMp4Buffer: Buffer;

  beforeAll(async () => {
    // Generate a real 2-second 320x240 MP4 video using ffmpeg
    const tempSampleMp4 = join(tmpdir(), `e2e-sample-${Date.now()}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=15',
      '-pix_fmt',
      'yuv420p',
      tempSampleMp4,
    ]);
    sampleMp4Buffer = await readFile(tempSampleMp4);
    await unlink(tempSampleMp4).catch(() => undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = app.get(DataSource);
    authService = app.get(AuthService);
    storageService = app.get(StorageService);
    throttlerStorage = app.get<{ storage: Record<string, unknown> }>(
      ThrottlerStorage,
    ).storage;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearMailpitMessages();
    if (
      throttlerStorage &&
      typeof (throttlerStorage as any).clear === 'function'
    ) {
      (throttlerStorage as any).clear();
    }
  });

  async function registerConfirmAndGetAccessToken(
    email: string,
    password = 'Password123!',
  ): Promise<string> {
    let confirmToken = '';
    const mailServiceInstance = (authService as any).mailService;
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmToken })
      .expect(204);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return (loginRes.body as { access_token: string }).access_token;
  }

  async function waitForVideoReady(
    slug: string,
    timeoutMs = 15_000,
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .expect(200);
      if (
        res.body.status === VideoStatus.READY ||
        res.body.status === VideoStatus.FAILED
      ) {
        return res.body;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for video ${slug} to finish processing`);
  }

  it('requires authentication on POST /videos/uploads/init (401 without token)', async () => {
    await request(app.getHttpServer())
      .post('/videos/uploads/init')
      .send({
        title: 'Unauthorized Upload',
        original_filename: 'video.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      })
      .expect(401);
  });

  it('supports declaring a 10GB upload in POST /videos/uploads/init and rejects >10GB with 413 VIDEO_FILE_TOO_LARGE', async () => {
    const token = await registerConfirmAndGetAccessToken(
      '10gb_user@example.com',
    );

    // 10GB exact succeeds and pre-registers as draft
    const init10GbRes = await request(app.getHttpServer())
      .post('/videos/uploads/init')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Full 10GB Cinema Master',
        original_filename: 'cinema-10gb.mp4',
        mime_type: 'video/mp4',
        size_bytes: TEN_GIGABYTES_IN_BYTES,
      })
      .expect(201);

    expect(init10GbRes.body.status).toBe('draft');
    expect(init10GbRes.body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(init10GbRes.body.total_parts).toBeLessThanOrEqual(10000);

    // >10GB is rejected with 413 VIDEO_FILE_TOO_LARGE
    const tooLargeRes = await request(app.getHttpServer())
      .post('/videos/uploads/init')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Exceeds 10GB',
        original_filename: 'too-big.mp4',
        mime_type: 'video/mp4',
        size_bytes: TEN_GIGABYTES_IN_BYTES + 1,
      })
      .expect(413);

    expect(tooLargeRes.body).toMatchObject({
      statusCode: 413,
      error: 'VIDEO_FILE_TOO_LARGE',
    });
  });

  it('executes full lifecycle: init draft -> direct MinIO upload -> complete -> background FFmpeg processing -> unique URL -> HTTP Range 206 streaming -> download -> thumbnail', async () => {
    const token = await registerConfirmAndGetAccessToken(
      'full_lifecycle@example.com',
    );

    // 1. Initiate upload -> creates draft with unique slug
    const initRes = await request(app.getHttpServer())
      .post('/videos/uploads/init')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'StreamTube E2E Masterclass',
        description: 'Complete E2E test with FFmpeg and Range streaming',
        original_filename: 'masterclass.mp4',
        mime_type: 'video/mp4',
        size_bytes: sampleMp4Buffer.length,
      })
      .expect(201);

    const videoId = initRes.body.id as string;
    const slug = initRes.body.slug as string;
    const partUploadUrl = initRes.body.presigned_urls[0].upload_url as string;

    expect(initRes.body.status).toBe('draft');
    expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);

    // Streaming a draft video before processing returns 409 VIDEO_NOT_READY
    await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(409);

    // 2. Upload MP4 bytes directly to MinIO using the presigned part URL
    const s3PutRes = await fetch(partUploadUrl, {
      method: 'PUT',
      body: new Uint8Array(sampleMp4Buffer),
    });
    expect(s3PutRes.ok).toBe(true);
    const etag = s3PutRes.headers.get('etag')!;

    // 3. Complete multipart upload -> transitions to processing and enqueues BullMQ job
    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parts: [{ part_number: 1, etag }],
      })
      .expect(202);

    expect(completeRes.body.status).toBe('processing');

    // 4. Wait for background worker (VideoProcessor) to extract metadata and generate thumbnail
    const readyVideo = await waitForVideoReady(slug);
    expect(readyVideo.status).toBe('ready');
    expect(readyVideo.duration_seconds).toBe(2);
    expect(readyVideo.width).toBe(320);
    expect(readyVideo.height).toBe(240);
    expect(readyVideo.codec).toBeTruthy();
    expect(readyVideo.stream_url).toBe(`/videos/${slug}/stream`);
    expect(readyVideo.download_url).toBe(`/videos/${slug}/download`);
    expect(readyVideo.thumbnail_url).toBe(`/videos/${slug}/thumbnail`);

    // 5. Stream partial byte range (RFC 9110 206 Partial Content) without downloading full file
    const rangeEnd = Math.min(511, sampleMp4Buffer.length - 1);
    const streamRangeRes = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .set('Range', `bytes=0-${rangeEnd}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(206);

    expect(streamRangeRes.headers['accept-ranges']).toBe('bytes');
    expect(streamRangeRes.headers['content-range']).toBe(
      `bytes 0-${rangeEnd}/${sampleMp4Buffer.length}`,
    );
    expect(Number(streamRangeRes.headers['content-length'])).toBe(rangeEnd + 1);
    const partialBody = streamRangeRes.body as Buffer;
    expect(partialBody.length).toBe(rangeEnd + 1);
    expect(partialBody.equals(sampleMp4Buffer.subarray(0, rangeEnd + 1))).toBe(
      true,
    );

    // 6. Out-of-bounds Range header returns 416 INVALID_BYTE_RANGE with Content-Range: bytes */<total>
    const invalidRangeRes = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .set(
        'Range',
        `bytes=${sampleMp4Buffer.length + 1000}-${sampleMp4Buffer.length + 2000}`,
      )
      .expect(416);

    expect(invalidRangeRes.headers['content-range']).toBe(
      `bytes */${sampleMp4Buffer.length}`,
    );

    // 7. Download full video with Content-Disposition: attachment
    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(downloadRes.headers['content-disposition']).toBe(
      'attachment; filename="masterclass.mp4"',
    );
    expect(Number(downloadRes.headers['content-length'])).toBe(
      sampleMp4Buffer.length,
    );
    const downloadedBody = downloadRes.body as Buffer;
    expect(downloadedBody.equals(sampleMp4Buffer)).toBe(true);

    // 8. Retrieve generated JPEG thumbnail
    const thumbRes = await request(app.getHttpServer())
      .get(`/videos/${slug}/thumbnail`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(thumbRes.headers['content-type']).toMatch(/image\/jpeg/);
    const thumbBody = thumbRes.body as Buffer;
    expect(thumbBody[0]).toBe(0xff);
    expect(thumbBody[1]).toBe(0xd8);
    expect(thumbBody[2]).toBe(0xff);

    // Cleanup MinIO test artifacts
    await storageService.deleteObject(initRes.body.storage_key as string);
    await storageService.deleteObject(`thumbnails/${videoId}/thumb.jpg`);
  });

  it('prevents non-owners from completing or aborting another user video (403 VIDEO_FORBIDDEN)', async () => {
    const ownerToken = await registerConfirmAndGetAccessToken(
      'owner_vid@example.com',
    );
    const intruderToken = await registerConfirmAndGetAccessToken(
      'intruder_vid@example.com',
    );

    const initRes = await request(app.getHttpServer())
      .post('/videos/uploads/init')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Owner Video',
        original_filename: 'owner.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      })
      .expect(201);

    const videoId = initRes.body.id as string;

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({})
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/videos/${videoId}/uploads/abort`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);

    // Owner can abort cleanly
    await request(app.getHttpServer())
      .delete(`/videos/${videoId}/uploads/abort`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
  });
});
