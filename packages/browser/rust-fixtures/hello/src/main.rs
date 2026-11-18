//! A WASI command: prints its arguments and `GREETING`, reads `input.txt`, writes
//! `output.txt`, and exits with the argument count (the runtime's command path).

use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    println!("hello from rust: {}", args.join(" "));
    if let Ok(greeting) = std::env::var("GREETING") {
        println!("GREETING={greeting}");
    }
    match fs::read_to_string("input.txt") {
        Ok(text) => {
            fs::write("output.txt", text.to_uppercase()).expect("write output.txt");
            println!("wrote output.txt");
        }
        Err(error) => eprintln!("no input.txt: {error}"),
    }
    std::process::exit(args.len() as i32);
}
