//! What Bazhen decides about agents, their mail and their roles without touching the world, as
//! packages/core decides it: the lifecycle machines, the commands an agent is offered, how mail
//! is labelled, which role files resolve, and what a role file's text defines. It does no I/O, so
//! the daemon and its tests share one answer.

pub mod agent;
pub mod attention;
pub mod machine;
pub mod mail;
pub mod role_file;
pub mod roles;
mod yaml;
