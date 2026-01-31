/**
 * Video Processing Orchestration
 *
 * Handles the complete video processing pipeline:
 * 1. Download (if URL)
 * 2. Extract frames and audio
 * 3. Select optimal frames for description
 * 4. Generate descriptions via Haiku subagent
 * 5. Synthesize into holistic video memory
 *
 * Uses Rust NAPI for frame selection and prompt generation.
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Try to load native bindings
let nativeModule: typeof import("@lucid-memory/native") | null = null
try {
	nativeModule = await import("@lucid-memory/native")
} catch {
	// Native module not available
}

export interface VideoMetadata {
	duration: number // seconds
	width: number
	height: number
	fps: number
	codec: string
}

export interface FrameInfo {
	index: number
	timestamp: number
	path: string
	isKeyframe: boolean
	isSceneChange: boolean
	qualityScore: number
}

export interface TranscriptSegment {
	start: number
	end: number
	text: string
}

export interface FrameDescription {
	description: string
	objects: string[]
	valence: number
	arousal: number
	significance: number
}

export interface VideoProcessingResult {
	description: string // Synthesized holistic description
	frameDescriptions: FrameDescription[] // Individual frame descriptions
	transcript: string | null // Audio transcript
	metadata: VideoMetadata
	objects: string[] // Aggregated objects from all frames
	avgValence: number
	avgArousal: number
	maxSignificance: number
}

export interface VideoProcessingOptions {
	sharedBy?: string
	maxFrames?: number // Default: 20
	workDir?: string // Temp directory for processing
}

/**
 * Run a command and return stdout.
 */
function runCommand(
	cmd: string,
	args: string[],
	options: { timeout?: number } = {}
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "pipe"],
		})

		let stdout = ""
		let stderr = ""

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString()
		})

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString()
		})

		const timeout = options.timeout ?? 60000
		const timer = setTimeout(() => {
			proc.kill()
			reject(new Error(`Command timed out after ${timeout}ms`))
		}, timeout)

		proc.on("close", (code) => {
			clearTimeout(timer)
			if (code === 0) {
				resolve(stdout)
			} else {
				reject(new Error(`Command failed with code ${code}: ${stderr}`))
			}
		})

		proc.on("error", (err) => {
			clearTimeout(timer)
			reject(err)
		})
	})
}

/**
 * Check if a command exists.
 */
async function commandExists(cmd: string): Promise<boolean> {
	try {
		await runCommand("which", [cmd], { timeout: 5000 })
		return true
	} catch {
		return false
	}
}

/**
 * Download a video from URL using yt-dlp.
 */
export async function downloadVideo(
	url: string,
	outputDir: string
): Promise<string> {
	const hasYtdlp = await commandExists("yt-dlp")
	if (!hasYtdlp) {
		throw new Error(
			"yt-dlp is not installed. Install with: brew install yt-dlp"
		)
	}

	const outputPath = join(outputDir, "video.%(ext)s")

	await runCommand(
		"yt-dlp",
		[
			"-f",
			"best[height<=720]", // Limit resolution
			"-o",
			outputPath,
			"--no-playlist",
			url,
		],
		{ timeout: 300000 } // 5 min timeout
	)

	// Find the downloaded file
	const files = await runCommand("ls", [outputDir])
	const videoFile = files
		.split("\n")
		.find((f: string) => f.startsWith("video."))
	if (!videoFile) {
		throw new Error("Failed to find downloaded video")
	}

	return join(outputDir, videoFile.trim())
}

/**
 * Get video metadata using ffprobe.
 */
export async function getVideoMetadata(
	videoPath: string
): Promise<VideoMetadata> {
	const hasFfprobe = await commandExists("ffprobe")
	if (!hasFfprobe) {
		throw new Error(
			"ffprobe is not installed. Install with: brew install ffmpeg"
		)
	}

	const output = await runCommand(
		"ffprobe",
		[
			"-v",
			"quiet",
			"-print_format",
			"json",
			"-show_format",
			"-show_streams",
			videoPath,
		],
		{ timeout: 30000 }
	)

	const data = JSON.parse(output)
	const videoStream = data.streams?.find(
		(s: { codec_type: string }) => s.codec_type === "video"
	)

	if (!videoStream) {
		throw new Error("No video stream found")
	}

	// Parse fps from string like "30/1" or "29.97"
	let fps = 30
	if (videoStream.r_frame_rate) {
		const parts = videoStream.r_frame_rate.split("/")
		if (parts.length === 2) {
			fps = Number.parseInt(parts[0], 10) / Number.parseInt(parts[1], 10)
		} else {
			fps = Number.parseFloat(videoStream.r_frame_rate)
		}
	}

	return {
		duration: Number.parseFloat(data.format?.duration || "0"),
		width: videoStream.width || 0,
		height: videoStream.height || 0,
		fps,
		codec: videoStream.codec_name || "unknown",
	}
}

/**
 * Extract frames from video using ffmpeg.
 */
export async function extractFrames(
	videoPath: string,
	outputDir: string,
	options: { fps?: number; sceneThreshold?: number } = {}
): Promise<FrameInfo[]> {
	const hasFfmpeg = await commandExists("ffmpeg")
	if (!hasFfmpeg) {
		throw new Error(
			"ffmpeg is not installed. Install with: brew install ffmpeg"
		)
	}

	const framesDir = join(outputDir, "frames")
	if (!existsSync(framesDir)) {
		mkdirSync(framesDir, { recursive: true })
	}

	// Extract frames at specified fps (default: 1 fps for efficiency)
	const extractFps = options.fps ?? 1
	const outputPattern = join(framesDir, "frame_%04d.jpg")

	await runCommand(
		"ffmpeg",
		[
			"-i",
			videoPath,
			"-vf",
			`fps=${extractFps}`,
			"-q:v",
			"2", // High quality JPEG
			outputPattern,
		],
		{ timeout: 300000 }
	)

	// List extracted frames
	const files = await runCommand("ls", [framesDir])
	const frameFiles = files
		.split("\n")
		.filter((f: string) => f.startsWith("frame_") && f.endsWith(".jpg"))
		.sort()

	const frames: FrameInfo[] = frameFiles.map((file: string, index: number) => ({
		index,
		timestamp: index / extractFps,
		path: join(framesDir, file),
		isKeyframe: index === 0, // First frame is keyframe
		isSceneChange: false, // Would need scene detection
		qualityScore: 0.7, // Default quality
	}))

	return frames
}

/**
 * Transcribe audio using Whisper.
 */
export async function transcribeAudio(
	videoPath: string,
	outputDir: string
): Promise<TranscriptSegment[] | null> {
	// Check for whisper CLI
	const hasWhisper = await commandExists("whisper")
	if (!hasWhisper) {
		console.warn("[video] whisper not found, skipping transcription")
		return null
	}

	try {
		// Extract audio first
		const audioPath = join(outputDir, "audio.wav")
		await runCommand(
			"ffmpeg",
			[
				"-i",
				videoPath,
				"-vn",
				"-acodec",
				"pcm_s16le",
				"-ar",
				"16000",
				audioPath,
			],
			{ timeout: 120000 }
		)

		// Transcribe with whisper
		const transcriptPath = join(outputDir, "audio.json")
		await runCommand(
			"whisper",
			[
				audioPath,
				"--model",
				"tiny", // Fast model
				"--output_format",
				"json",
				"--output_dir",
				outputDir,
			],
			{ timeout: 300000 }
		)

		// Read transcript
		const transcriptFile = Bun.file(transcriptPath)
		if (await transcriptFile.exists()) {
			const data = await transcriptFile.json()
			return (
				data.segments?.map(
					(seg: { start: number; end: number; text: string }) => ({
						start: seg.start,
						end: seg.end,
						text: seg.text.trim(),
					})
				) || []
			)
		}
	} catch (error) {
		console.warn("[video] Transcription failed:", error)
	}

	return null
}

/**
 * Select frames for description using Rust NAPI.
 */
export function selectFrames(
	frames: FrameInfo[],
	maxFrames: number,
	transcript: TranscriptSegment[] | null
): number[] {
	if (nativeModule) {
		const jsFrames = frames.map((f) => ({
			index: f.index,
			timestampSeconds: f.timestamp,
			isKeyframe: f.isKeyframe,
			isSceneChange: f.isSceneChange,
			qualityScore: f.qualityScore,
		}))

		const jsTranscript = transcript?.map((t) => ({
			startSeconds: t.start,
			endSeconds: t.end,
			text: t.text,
		}))

		return nativeModule.videoSelectFrames(jsFrames, maxFrames, jsTranscript)
	}

	// TypeScript fallback: simple even distribution
	if (frames.length <= maxFrames) {
		return frames.map((_, i) => i)
	}

	const step = Math.floor(frames.length / maxFrames)
	const selected: number[] = [0] // Always include first

	for (let i = step; i < frames.length; i += step) {
		if (selected.length < maxFrames - 1) {
			selected.push(i)
		}
	}

	// Always include last
	if (selected[selected.length - 1] !== frames.length - 1) {
		selected.push(frames.length - 1)
	}

	return selected.slice(0, maxFrames)
}

/**
 * Generate prompt for describing a frame.
 */
export function prepareFramePrompt(
	frame: FrameInfo,
	videoDuration: number,
	transcript: TranscriptSegment[] | null,
	sharedBy?: string
): string {
	// Find transcript near this frame
	const nearbyTranscript = transcript?.find(
		(t) => frame.timestamp >= t.start && frame.timestamp <= t.end
	)?.text

	if (nativeModule) {
		return nativeModule.videoPrepareForSubagent(
			frame.timestamp,
			videoDuration,
			nearbyTranscript ?? null,
			frame.isSceneChange,
			sharedBy ?? null,
			null // Use default config
		)
	}

	// TypeScript fallback
	const position = `${Math.round(frame.timestamp)}s/${Math.round(videoDuration)}s`
	const transcriptContext = nearbyTranscript
		? `\n\nAudio: "${nearbyTranscript}"`
		: ""
	const sharedContext = sharedBy ? ` (shared by ${sharedBy})` : ""

	return `Describe this video frame concisely. Position: ${position}.${sharedContext}${transcriptContext}

Respond with JSON:
{
  "description": "[what's happening in this frame, 200 chars max]",
  "objects": ["list", "of", "objects"],
  "valence": 0,
  "arousal": 0.5,
  "significance": 0.5
}`
}

/**
 * Synthesize frame descriptions into a holistic video description.
 */
export function synthesizeDescription(
	frameDescriptions: FrameDescription[],
	timestamps: number[],
	transcript: TranscriptSegment[] | null,
	videoDuration: number
): string {
	// Build frame summary
	const frameSummary = frameDescriptions
		.map(
			(fd, i) =>
				`Frame ${i + 1} (${Math.round(timestamps[i] ?? 0)}s): ${fd.description}`
		)
		.join("\n")

	const transcriptText = transcript?.map((t) => t.text).join(" ") || null

	if (nativeModule) {
		return nativeModule.videoPrepareSynthesisPrompt(
			frameDescriptions.map((fd) => fd.description),
			frameDescriptions.map((fd) => fd.valence),
			frameDescriptions.map((fd) => fd.arousal),
			frameDescriptions.map((fd) => fd.significance),
			timestamps,
			transcriptText,
			videoDuration
		)
	}

	// TypeScript fallback
	const transcriptSection = transcriptText
		? `\n\nTranscript: "${transcriptText}"`
		: ""

	return `Synthesize these frame descriptions into a cohesive 2-3 sentence summary of what this ${Math.round(videoDuration)}s video shows.

${frameSummary}${transcriptSection}

Write a natural description that captures the essence of the video, not just a list of frames.`
}

/**
 * Aggregate objects and compute average emotions from frame descriptions.
 */
export function aggregateFrameData(descriptions: FrameDescription[]): {
	objects: string[]
	avgValence: number
	avgArousal: number
	maxSignificance: number
} {
	const objectSet = new Set<string>()
	let totalValence = 0
	let totalArousal = 0
	let maxSignificance = 0

	for (const fd of descriptions) {
		for (const obj of fd.objects) {
			objectSet.add(obj.toLowerCase())
		}
		totalValence += fd.valence
		totalArousal += fd.arousal
		if (fd.significance > maxSignificance) {
			maxSignificance = fd.significance
		}
	}

	const count = descriptions.length || 1

	return {
		objects: Array.from(objectSet),
		avgValence: totalValence / count,
		avgArousal: totalArousal / count,
		maxSignificance,
	}
}

/**
 * Clean up temporary processing directory.
 */
export function cleanupWorkDir(workDir: string): void {
	try {
		rmSync(workDir, { recursive: true, force: true })
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Create a temporary work directory for video processing.
 */
export function createWorkDir(): string {
	const workDir = join(tmpdir(), `lucid-video-${randomUUID()}`)
	mkdirSync(workDir, { recursive: true })
	return workDir
}
