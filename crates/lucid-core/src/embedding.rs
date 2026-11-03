//! In-process ONNX embedding model (BGE-base-en-v1.5).
//!
//! Runs BGE-base directly via ONNX Runtime — no external services needed.
//! Produces 768-dimensional embeddings with mean pooling + L2 normalization.

use ndarray::{Array2, ArrayD};
use ort::session::Session;
use ort::value::Tensor;
use parking_lot::Mutex;
use std::path::PathBuf;
use tokenizers::{Encoding, PaddingDirection, PostProcessor, Tokenizer, TruncationDirection};

/// BGE-base-en-v1.5 has 512 position embeddings, including special tokens.
const MAX_SEQUENCE_LENGTH: usize = 512;

/// Default model directory: `~/.lucid/models`
fn default_model_dir() -> PathBuf {
	dirs::home_dir()
		.unwrap_or_else(|| PathBuf::from("."))
		.join(".lucid")
		.join("models")
}

/// Configuration for loading the embedding model.
#[derive(Debug, Clone)]
pub struct EmbeddingModelConfig {
	/// Path to the ONNX model file.
	pub model_path: Option<PathBuf>,
	/// Path to the tokenizer.json file.
	pub tokenizer_path: Option<PathBuf>,
}

impl Default for EmbeddingModelConfig {
	fn default() -> Self {
		let dir = default_model_dir();
		Self {
			model_path: Some(dir.join("bge-base-en-v1.5-quantized.onnx")),
			tokenizer_path: Some(dir.join("bge-base-en-v1.5-tokenizer.json")),
		}
	}
}

/// In-process embedding model using ONNX Runtime.
///
/// Thread-safe: wraps `ort::Session` in a `Mutex` since `Session::run`
/// requires `&mut self`. The lock is held only during ONNX inference.
pub struct EmbeddingModel {
	session: Mutex<Session>,
	tokenizer: Tokenizer,
}

/// Error type for embedding operations.
#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
	/// ONNX Runtime error.
	#[error("ONNX Runtime error: {0}")]
	Ort(#[from] ort::Error),

	/// Tokenizer error.
	#[error("Tokenizer error: {0}")]
	Tokenizer(String),

	/// Model files not found.
	#[error("Model files not found: {0}")]
	NotFound(String),

	/// Shape error from ndarray.
	#[error("Shape error: {0}")]
	Shape(#[from] ndarray::ShapeError),
}

fn configure_tokenizer(tokenizer: &mut Tokenizer) -> Result<(), EmbeddingError> {
	let mut truncation = tokenizer.get_truncation().cloned().unwrap_or_default();
	truncation.max_length = truncation.max_length.min(MAX_SEQUENCE_LENGTH);
	let special_tokens = tokenizer
		.get_post_processor()
		.map_or(0, |p| p.added_tokens(false));
	if special_tokens > truncation.max_length {
		return Err(EmbeddingError::Tokenizer(format!(
			"sequence limit {} cannot fit {special_tokens} special tokens",
			truncation.max_length
		)));
	}
	// Only the first window is embedded.
	truncation.stride = 0;
	tokenizer
		.with_truncation(Some(truncation))
		.map(|_| ())
		.map_err(|e| EmbeddingError::Tokenizer(e.to_string()))
}

fn encode_batch(tokenizer: &Tokenizer, texts: &[&str]) -> Result<Vec<Encoding>, EmbeddingError> {
	let mut rows = tokenizer
		.encode_batch(texts.to_vec(), true)
		.map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
	if let Some(padding) = tokenizer.get_padding() {
		// Content and special tokens already fit. Only configured padding can exceed the cap.
		let side = match padding.direction {
			PaddingDirection::Left => TruncationDirection::Left,
			PaddingDirection::Right => TruncationDirection::Right,
		};
		for row in &mut rows {
			row.truncate(MAX_SEQUENCE_LENGTH, 0, side);
		}
	}
	Ok(rows)
}

impl EmbeddingModel {
	/// Load the ONNX model and tokenizer from disk.
	///
	/// # Errors
	///
	/// Returns an error if the model or tokenizer files cannot be loaded.
	pub fn load(config: &EmbeddingModelConfig) -> Result<Self, EmbeddingError> {
		let default = EmbeddingModelConfig::default();

		let model_path = config
			.model_path
			.as_ref()
			.or(default.model_path.as_ref())
			.ok_or_else(|| EmbeddingError::NotFound("no model path".into()))?;

		let tokenizer_path = config
			.tokenizer_path
			.as_ref()
			.or(default.tokenizer_path.as_ref())
			.ok_or_else(|| EmbeddingError::NotFound("no tokenizer path".into()))?;

		if !model_path.exists() {
			return Err(EmbeddingError::NotFound(format!(
				"ONNX model not found at {}",
				model_path.display()
			)));
		}

		if !tokenizer_path.exists() {
			return Err(EmbeddingError::NotFound(format!(
				"Tokenizer not found at {}",
				tokenizer_path.display()
			)));
		}

		let session = Session::builder()?.commit_from_file(model_path)?;

		let mut tokenizer = Tokenizer::from_file(tokenizer_path)
			.map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
		configure_tokenizer(&mut tokenizer)?;

		Ok(Self {
			session: Mutex::new(session),
			tokenizer,
		})
	}

	/// Check whether model files exist at the given (or default) paths.
	pub fn is_available(config: &EmbeddingModelConfig) -> bool {
		let default = EmbeddingModelConfig::default();
		let model_path = config.model_path.as_ref().or(default.model_path.as_ref());
		let tokenizer_path = config
			.tokenizer_path
			.as_ref()
			.or(default.tokenizer_path.as_ref());

		matches!((model_path, tokenizer_path), (Some(m), Some(t)) if m.exists() && t.exists())
	}

	/// Embed a single text. Returns a 768-dimensional f32 vector.
	///
	/// # Errors
	///
	/// Returns an error if tokenization or inference fails.
	pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
		let batch = self.embed_batch(&[text])?;
		batch
			.into_iter()
			.next()
			.ok_or_else(|| EmbeddingError::Tokenizer("empty batch result".into()))
	}

	/// Run ONNX inference and return the owned output array.
	///
	/// Locks the session mutex only for the duration of the inference call,
	/// extracting owned data before the lock is released.
	///
	/// # Errors
	///
	/// Returns an error if the session lock is poisoned or inference fails.
	fn run_inference(
		&self,
		input_ids_tensor: Tensor<i64>,
		attention_mask_tensor: Tensor<i64>,
		token_type_tensor: Tensor<i64>,
	) -> Result<(ArrayD<f32>, usize), EmbeddingError> {
		let mut session = self.session.lock();
		let outputs = session.run(ort::inputs![
			"input_ids" => input_ids_tensor,
			"attention_mask" => attention_mask_tensor,
			"token_type_ids" => token_type_tensor,
		])?;
		let view = outputs[0]
			.try_extract_array::<f32>()
			.map_err(EmbeddingError::Ort)?;
		let dim = view.shape().last().copied().unwrap_or(768);
		Ok((view.into_owned(), dim))
	}

	/// Embed a batch of texts. Pads to max length in the batch for a single ONNX run.
	///
	/// # Errors
	///
	/// Returns an error if tokenization or inference fails.
	pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
		if texts.is_empty() {
			return Ok(vec![]);
		}

		let encodings = encode_batch(&self.tokenizer, texts)?;

		let max_len = encodings
			.iter()
			.map(|e| e.get_ids().len())
			.max()
			.unwrap_or(0);
		let batch_size = encodings.len();

		// Build padded input tensors
		let mut input_ids = vec![0i64; batch_size * max_len];
		let mut attention_mask = vec![0i64; batch_size * max_len];
		let token_type_ids = vec![0i64; batch_size * max_len];

		for (i, enc) in encodings.iter().enumerate() {
			let ids = enc.get_ids();
			let mask = enc.get_attention_mask();
			let offset = i * max_len;
			for (j, &id) in ids.iter().enumerate() {
				input_ids[offset + j] = i64::from(id);
			}
			for (j, &m) in mask.iter().enumerate() {
				attention_mask[offset + j] = i64::from(m);
			}
		}

		let input_ids_arr = Array2::from_shape_vec([batch_size, max_len], input_ids)?;
		let attention_mask_arr =
			Array2::from_shape_vec([batch_size, max_len], attention_mask.clone())?;
		let token_type_arr = Array2::from_shape_vec([batch_size, max_len], token_type_ids)?;

		let input_ids_tensor = Tensor::from_array(input_ids_arr)?;
		let attention_mask_tensor = Tensor::from_array(attention_mask_arr)?;
		let token_type_tensor = Tensor::from_array(token_type_arr)?;

		// Run ONNX inference (lock scoped to run_inference)
		let (output_array, hidden_dim) =
			self.run_inference(input_ids_tensor, attention_mask_tensor, token_type_tensor)?;

		// Mean pooling + L2 normalization (no lock held)
		let mut results = Vec::with_capacity(batch_size);

		for (i, enc) in encodings.iter().enumerate() {
			let mut seq_len = 0u16;
			let mut pooled = vec![0.0f32; hidden_dim];
			for (t, &mask) in enc.get_attention_mask().iter().enumerate() {
				if mask == 0 {
					continue;
				}
				seq_len += 1;
				for d in 0..hidden_dim {
					pooled[d] += output_array[[i, t, d]];
				}
			}
			if seq_len > 0 {
				let divisor = f32::from(seq_len);
				for v in &mut pooled {
					*v /= divisor;
				}
			}

			// L2 normalize
			let norm: f32 = pooled.iter().map(|v| v * v).sum::<f32>().sqrt();
			if norm > 0.0 {
				for v in &mut pooled {
					*v /= norm;
				}
			}

			results.push(pooled);
		}

		Ok(results)
	}

	/// Returns the model name.
	#[must_use]
	pub const fn model_name(&self) -> &'static str {
		"bge-base-en-v1.5"
	}

	/// Returns the embedding dimensions.
	#[must_use]
	pub const fn dimensions(&self) -> usize {
		768
	}
}

/// Check if the default model files are available.
pub fn is_model_available() -> bool {
	EmbeddingModel::is_available(&EmbeddingModelConfig::default())
}

/// Returns the default model directory path.
#[must_use]
pub fn model_dir() -> PathBuf {
	default_model_dir()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
	use super::*;
	use tokenizers::{
		models::wordpiece::WordPiece, pre_tokenizers::whitespace::WhitespaceSplit,
		processors::bert::BertProcessing, PaddingParams, PaddingStrategy,
	};

	fn load_test_model() -> EmbeddingModel {
		let mut config = EmbeddingModelConfig::default();
		if let Some(dir) = std::env::var_os("LUCID_TEST_MODEL_DIR") {
			let dir = PathBuf::from(dir);
			config.model_path = Some(dir.join("bge-base-en-v1.5-quantized.onnx"));
			config.tokenizer_path = Some(dir.join("bge-base-en-v1.5-tokenizer.json"));
		}
		EmbeddingModel::load(&config).expect("Failed to load model")
	}

	#[test]
	fn test_default_config_paths() {
		let config = EmbeddingModelConfig::default();
		let model_path = config.model_path.as_ref().unwrap();
		let tokenizer_path = config.tokenizer_path.as_ref().unwrap();

		assert!(model_path.to_string_lossy().contains("bge-base-en-v1.5"));
		assert!(tokenizer_path.to_string_lossy().contains("tokenizer"));
	}

	#[test]
	fn test_is_available_false_without_files() {
		let config = EmbeddingModelConfig {
			model_path: Some(PathBuf::from("/nonexistent/model.onnx")),
			tokenizer_path: Some(PathBuf::from("/nonexistent/tokenizer.json")),
		};
		assert!(!EmbeddingModel::is_available(&config));
	}

	fn wordpiece_tokenizer() -> Tokenizer {
		let wordpiece = WordPiece::builder()
			.vocab([("sun".into(), 1), ("##ny".into(), 2)].into())
			.build()
			.unwrap();
		let mut tokenizer = Tokenizer::new(wordpiece);
		let _ = tokenizer
			.with_pre_tokenizer(Some(WhitespaceSplit))
			.with_post_processor(Some(BertProcessing::default()));
		tokenizer
	}

	#[test]
	fn test_token_limit_preserves_wordpieces_special_tokens_and_masks() {
		let mut tokenizer = wordpiece_tokenizer();
		configure_tokenizer(&mut tokenizer).unwrap();

		// "sunny" splits into two pieces. The content budget is 510 plus CLS and SEP.
		let content_lengths = [0, 1, 509, 510, 511, 653];
		let texts = content_lengths.map(|count| {
			let mut text = "sunny ".repeat(count / 2);
			if count % 2 == 1 {
				text.push_str("sun");
			}
			text
		});
		let batch = encode_batch(&tokenizer, &texts.each_ref().map(String::as_str)).unwrap();
		assert_eq!(batch.len(), content_lengths.len());
		for (row, kept) in batch.iter().zip([0, 1, 509, 510, 510, 510]) {
			let mut expected = vec![101]; // CLS
			expected.extend([1, 2].into_iter().cycle().take(kept));
			expected.push(102); // SEP
			assert_eq!(row.get_ids(), expected);
			assert_eq!(row.get_attention_mask(), vec![1; kept + 2]);
		}
	}

	#[test]
	fn test_padding_only_trimmed_when_it_exceeds_model_width() {
		for direction in [PaddingDirection::Right, PaddingDirection::Left] {
			for (fixed_width, multiple, expected_width) in
				[(8, 6, 12), (512, 6, 512), (1024, 1, 512)]
			{
				let mut tokenizer = wordpiece_tokenizer();
				let _ = tokenizer.with_padding(Some(PaddingParams {
					strategy: PaddingStrategy::Fixed(fixed_width),
					direction,
					pad_to_multiple_of: Some(multiple),
					..Default::default()
				}));
				configure_tokenizer(&mut tokenizer).unwrap();
				let rows = encode_batch(&tokenizer, &["sunny"]).unwrap();
				let row = &rows[0];
				assert_eq!(row.len(), expected_width);
				let start = match direction {
					PaddingDirection::Left => expected_width - 4,
					PaddingDirection::Right => 0,
				};
				let mut ids = vec![0; expected_width];
				let mut mask = vec![0; expected_width];
				ids[start..start + 4].copy_from_slice(&[101, 1, 2, 102]);
				mask[start..start + 4].fill(1);
				assert_eq!(row.get_ids(), ids);
				assert_eq!(row.get_attention_mask(), mask);
			}
		}
	}

	#[test]
	fn test_tokenizer_rejects_limit_too_small_for_special_tokens() {
		let mut tokenizer = Tokenizer::new(WordPiece::default());
		let _ = tokenizer
			.with_truncation(Some(tokenizers::TruncationParams {
				max_length: 1,
				..Default::default()
			}))
			.unwrap()
			.with_post_processor(Some(BertProcessing::default()));
		assert!(matches!(
			configure_tokenizer(&mut tokenizer),
			Err(EmbeddingError::Tokenizer(_))
		));
	}

	// With model files in ~/.lucid/models or LUCID_TEST_MODEL_DIR:
	// cargo test -p lucid-core --features embedding --lib embedding::tests -- --include-ignored
	#[test]
	#[ignore = "requires model files on disk"]
	fn test_embed_single() {
		let model = load_test_model();
		let vector = model.embed("Hello, world!").expect("Failed to embed");
		assert_eq!(vector.len(), 768);

		// Verify L2 normalized (norm ≈ 1.0)
		let norm: f32 = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
		assert!((norm - 1.0).abs() < 0.01);
	}

	#[test]
	#[ignore = "requires model files on disk"]
	fn test_embed_batch() {
		let model = load_test_model();
		let texts = &["Hello, world!", "Rust is great for systems programming"];
		let results = model.embed_batch(texts).expect("Failed to embed batch");

		assert_eq!(results.len(), 2);
		for vec in &results {
			assert_eq!(vec.len(), 768);
		}

		// Different texts should produce different embeddings
		let dot: f32 = results[0]
			.iter()
			.zip(results[1].iter())
			.map(|(a, b)| a * b)
			.sum();
		assert!(dot < 0.99, "Different texts should have similarity < 0.99");
	}

	#[test]
	#[ignore = "requires model files on disk"]
	fn test_embed_overlong_single() {
		let model = load_test_model();
		let prefix = "hello ".repeat(510);
		let overlong = format!("{prefix}{}", "world ".repeat(143)); // 655 tokens including CLS and SEP
		let vector = model.embed(&overlong).unwrap();
		assert_eq!(vector, model.embed(&prefix).unwrap());
	}

	#[test]
	#[ignore = "requires model files on disk"]
	fn test_embed_mixed_lengths() {
		let model = load_test_model();
		let short = "The apple fell from the tree.";
		let prefix = "hello ".repeat(510);
		let overlong = format!("{prefix}world"); // 513 tokens including CLS and SEP
		let batch = model.embed_batch(&[short, &overlong, &prefix]).unwrap();
		assert_eq!(batch.len(), 3);
		assert_eq!(batch[1], batch[2]);
		for vector in &batch {
			assert_eq!(vector.len(), 768);
			let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
			assert!((norm - 1.0).abs() < 1e-5, "unexpected norm {norm}");
		}

		// Dynamic quantization can vary slightly with batch composition and padding.
		let single = model.embed(short).unwrap();
		let similarity: f32 = batch[0].iter().zip(single).map(|(a, b)| a * b).sum();
		assert!(
			similarity > 0.98,
			"padded short input similarity {similarity}"
		);
	}
}
