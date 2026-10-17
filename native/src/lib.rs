// High-performance native modules for Lunx
// Focus: Speed and minimal bundle size

mod graph;
mod transform;
mod orchestrator;
mod cache;
// Phase 3 — additive new modules
mod chunker;
mod sourcemap_merger;
mod watcher;
mod prebundle;
// Phase 4 — competitive superiority
mod task_graph;
// CommonJS → ESM lexer for production builds (src/build/cjs-lexer.ts)
mod cjs_lexer;

// Re-export transform module
pub use transform::{transform_js, transform_css, transform_vue};
// Re-export graph module
pub use graph::{
  GraphAnalyzer, GraphNode, CircularDependency, GraphAnalysisResult,
  fast_hash, batch_hash, scan_imports, normalize_path
};

// Re-export orchestrator module
pub use orchestrator::{
  BuildOrchestrator, BuildEvent, OrchestratorStats,
  get_optimal_parallelism, benchmark_parallelism
};

// Re-export cache module
pub use cache::{
  BuildCache, CacheStats,
  create_input_key, create_graph_key, create_plan_key, create_artifact_key
};

// Phase 3 re-exports
pub use chunker::{ChunkerConfig, ChunkOutput, ChunkerResult, lunx_chunk};
pub use sourcemap_merger::merge_source_maps;
pub use watcher::{NativeWatcher, WatchEvent, start_watcher};
pub use prebundle::{PrebundleEntry, PrebundleConfig, prebundle, prebundle_put};
// Phase 4 re-exports
pub use task_graph::{Task, TaskPlan, plan_build};
pub use cjs_lexer::lex_cjs_exports;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct TransformConfig {
    pub path: String,
    pub content: String,
    pub loader: String,
    pub minify: Option<bool>,
}

#[napi(object)]
pub struct TransformResult {
    pub code: String,
}

/// High-performance native worker for plugin transformations
#[napi]
pub struct NativeWorker {
  _pool_size: u32,
}

#[napi]
impl NativeWorker {
  /// Create a new native worker with specified pool size
  #[napi(constructor)]
  pub fn new(pool_size: Option<u32>) -> Self {
    Self {
      _pool_size: pool_size.unwrap_or(4),
    }
  }

  /// Transform code using native SWC, LightningCSS, or Vue engine
  #[napi]
  pub fn transform_sync(&self, config: TransformConfig) -> Result<TransformResult> {
    let minify = config.minify.unwrap_or(false);
    
    let result = if config.loader == "css" {
        transform_css(config.content, config.path, minify)
    } else if config.loader == "vue" {
        transform_vue(config.content, config.path, !minify) // !minify usually means dev
    } else {
        transform_js(config.content, config.path, minify)
    }.map_err(|e| Error::new(Status::GenericFailure, e))?;
    
    Ok(TransformResult { code: result })
  }

  /// Parallel Transform: Process multiple modules across all cores
  #[napi]
  pub async fn batch_transform(&self, items: Vec<TransformConfig>) -> Result<Vec<TransformResult>> {
    use rayon::prelude::*;
    
    // We use tokio_rt feature to spawn blocking for rayon
    // items is a list of TransformConfig
    let results = tokio::task::spawn_blocking(move || {
        items.into_par_iter()
             .map(|item| {
                 let minify = item.minify.unwrap_or(false);
                 let res = if item.loader == "css" {
                     transform_css(item.content, item.path, minify)
                 } else if item.loader == "vue" {
                     transform_vue(item.content, item.path, !minify)
                 } else {
                     transform_js(item.content, item.path, minify)
                 };

                 match res {
                     Ok(code) => Ok(TransformResult { code }),
                     Err(e) => Err(e)
                 }
             })
             .collect::<std::result::Result<Vec<TransformResult>, String>>()
    }).await.map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    results.map_err(|e| Error::new(Status::GenericFailure, e))
  }

  /// Parallel Transform CSS: Process multiple CSS modules across all cores asynchronously
  #[napi]
  pub async fn batch_transform_css(&self, items: Vec<TransformConfig>) -> Result<Vec<TransformResult>> {
    use rayon::prelude::*;
    
    let results = tokio::task::spawn_blocking(move || {
        items.into_par_iter()
             .map(|item| {
                 let minify = item.minify.unwrap_or(false);
                 match transform_css(item.content, item.path, minify) {
                     Ok(code) => Ok(TransformResult { code }),
                     Err(e) => Err(e)
                 }
             })
             .collect::<std::result::Result<Vec<TransformResult>, String>>()
    }).await.map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    results.map_err(|e| Error::new(Status::GenericFailure, e))
  }
}

/// Simple function to test native bindings
#[napi]
pub fn hello_rust() -> String {
  "Hello from Rust Native Worker!".to_string()
}

/// Global bundle minification pass
#[napi]
pub fn minify_sync(code: String) -> napi::Result<String> {
  transform::minify_js(code)
    .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
}

#[napi(js_name = "transformCss")]
pub fn napi_transform_css(code: String, filename: String, minify: bool) -> napi::Result<String> {
  transform::transform_css(code, filename, minify)
    .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
}

#[napi(js_name = "transformJs")]
pub fn napi_transform_js(code: String, filename: String, minify: bool) -> napi::Result<String> {
  transform::transform_js(code, filename, minify)
    .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
}

/// Benchmark function to compare performance
#[napi]
pub fn benchmark_transform(code: String, iterations: u32) -> f64 {
  use std::time::Instant;
  
  let start = Instant::now();
  for _ in 0..iterations {
    let _ = code.replace("console.log", "console.debug");
  }
  let duration = start.elapsed();
  
  duration.as_secs_f64()
}
