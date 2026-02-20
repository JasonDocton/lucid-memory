//! In-process ONNX embedding model (BGE-base-en-v1.5).
//!
//! Runs BGE-base directly via ONNX Runtime — no external services needed.
//! Produces 768-dimensional embeddings with mean pooling + L2 normalization.

use ndarray::{Array2, ArrayD};
use ort::session::Session;
use ort::value::Tensor;
use parking_lot::Mutex;
use std::path::PathBuf;
use tokenizers::Tokenizer;

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

		let tokenizer = Tokenizer::from_file(tokenizer_path)
			.map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;

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

		let encodings = self
			.tokenizer
			.encode_batch(texts.to_vec(), true)
			.map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;

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

		for i in 0..batch_size {
			let seq_len = encodings[i]
				.get_attention_mask()
				.iter()
				.filter(|&&m| m == 1)
				.count();

			let mut pooled = vec![0.0f32; hidden_dim];
			for t in 0..seq_len {
				for d in 0..hidden_dim {
					pooled[d] += output_array[[i, t, d]];
				}
			}
			if seq_len > 0 {
				// Lossless conversion: token counts fit in u16, and u16→f32 is exact
				let divisor = f32::from(u16::try_from(seq_len).unwrap_or(u16::MAX));
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

	// Integration tests require actual model files — run with:
	// cargo test --features embedding -- --ignored
	#[test]
	#[ignore = "requires model files on disk"]
	fn test_embed_single() {
		let model =
			EmbeddingModel::load(&EmbeddingModelConfig::default()).expect("Failed to load model");
		let vector = model.embed("Hello, world!").expect("Failed to embed");
		assert_eq!(vector.len(), 768);

		// Verify L2 normalized (norm ≈ 1.0)
		let norm: f32 = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
		assert!((norm - 1.0).abs() < 0.01);
	}

	#[test]
	#[ignore = "requires model files on disk"]
	fn test_embed_batch() {
		let model =
			EmbeddingModel::load(&EmbeddingModelConfig::default()).expect("Failed to load model");
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
}
