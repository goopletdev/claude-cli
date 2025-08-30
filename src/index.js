#!/usr/bin/env node
import axios from 'axios';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import dotenv from 'dotenv';
import fs from 'fs';
import dirname from 'path';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath});
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
    console.error(chalk.red('❌ ANTHROPIC_API_KEY not found in environment or .env file'));
    process.exit(1);
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const HISTORY_FILE = path.join('data', 'history.json');

const conversation = loadHistory();
let currentUsage = null;

function printUsage(usage) {
    if (!usage) {
        console.log("Current usage is null");
    } else {
        console.log(chalk.gray(`Input tokens: ${usage.input_tokens}`));
        console.log(chalk.gray(`Output tokens: ${usage.output_tokens}`));
    }
}

// Set up readline for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.on('close', () => {
    console.log(chalk.yellow('🧼 Cleaning up...'));
    saveHistory(conversation);
    console.log(chalk.yellow('👋 Goodbye!'));
    process.exit(0);
});

process.on('SIGINT', () => rl.close()); // ctrl+C
process.on('SIGTERM', () => rl.close()); // kill signall

function archiveHistory(conversation) {
    try {
        const timestamp = new Date().toISOString();
        const archiveEntry = {
            timestamp,
            messageCount: conversation.length,
            conversation: conversation
        };

        let archives = [];
        const ARCHIVE_FILE = path.join('data', 'archive.json');

        if (fs.existsSync(ARCHIVE_FILE)) {
            const archiveData = fs.readFileSync(ARCHIVE_FILE, 'utf8');
            archives = JSON.parse(archiveData);
        }

        archives.push(archiveEntry);

        fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archives, null, 2));
        console.log(chalk.gray(`📦 Archived ${conversation.length} messages at ${timestamp}`));

        return true;
    } catch (e) {
        console.log(chalk.red(`Error archiving history: ${error.message}`));
        return false;
    }
}

async function getSummary(conversation) {
    try {
        console.log(chalk.blue('🤖 Generating conversation summary...'));

        const summaryPrompt = "Please provide a detailed summary of our conversation so far. Include key topics discussed, brief outlines of significant code implementations, decisions made, concepts and syntax newly learned, and important context that should be preserved for future reference. This summary will replace our current chat history.";

        const summaryResponse = await axios.post(API_URL, {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            messages: [...conversation, { role: 'user', content: summaryPrompt }],
            stream: false,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            }
        });

        currentUsage = { 
            input_tokens: summaryResponse.data?.usage.input_tokens, 
            output_tokens: summaryResponse.data?.usage.output_tokens,
        }
        printUsage(currentUsage);

        return summaryResponse.data.content[0].text;
    } catch (error) {
        console.log(chalk.red('❌ Error generating summary:'));
        if (error.response) {
            console.log(chalk.red(`Status: ${error.response.status}`));
        }
        return null;
    }
}

function loadHistory() {
    try {
        if (!fs.existsSync('data')) {
            fs.mkdirSync('data', { recursive: true });
        }

        if (fs.existsSync(HISTORY_FILE)) {
            const historyData = fs.readFileSync(HISTORY_FILE, 'utf8');
            const parsedHistory = JSON.parse(historyData);

            console.log(chalk.green(`📚 Loaded ${parsedHistory.length} previous messages`));
            return parsedHistory;
        } else {
            console.log(chalk.gray('📝 Starting fresh conversation'));
            return [];
        }
    } catch (error) {
        console.log(chalk.red(`Error loading history: ${error.message}`));
        console.log(chalk.gray('Starting fresh conversation'));
        return[];
    }
}

function saveHistory(conversation) {
    try {
        if (!fs.existsSync('data')) {
            fs.mkdirSync('data', {recursive: true });
        }

        fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversation, null, 2));
        console.log(chalk.gray(`💾 Conversation saved (${conversation.length} messages)`));
    } catch (error) {
        console.log(chalk.red(`Error saving history: ${error.message}`));
    }
}

function formatNonCodeText(text) {
    return text
        .replace(/`([^`\n]+)`/g, chalk.bgBlack.cyan(' $1 '))
        .replace(/\*\*(.*?)\*\*/g, chalk.bold('$1'))
        .replace(/\*(.*?)\*/g, chalk.italic('$1'))
        .replace(/^(#{1,6})\s(.*)$/gm, (match, hashes, text) => {
            const level = hashes.length;
            if (level === 1) return chalk.yellow.bold.underline(text);
            if (level === 2) return chalk.yellow.bold(text);
            return chalk.yellow(text);
        })
        .replace(/^(\s*)([-*+])\s(.*)$/gm, '$1' + chalk.green('• ') + '$3');
}

function formatCodeBlock(code, language) {
    try {
        const languageMap = {
            'gitignore': 'bash',
            'dockerfile': 'bash',
            'env': 'bash',
            'txt': 'text',
            'log': 'text'
        };
        const mappedLanguage = languageMap[language] || language || 'text';
        return highlight(code, { language: mappedLanguage });
    } catch (e) {
        return code;
    }
}

function parseChunk(chunk) {
    const lines = chunk.toString().split('\n');
    let text = '';

    for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'content_block_delta' && data.delta?.text) {
                    text += data.delta.text;
                } else if (data.type === 'message_delta') {
                    currentUsage = data.usage;
                }
            } catch (e) {

            }
        }
    }

    return text;
}

async function sendMessageToClaude(userMessage) {
    try {
        conversation.push({ role: 'user', content: userMessage });

        console.log(chalk.blue('🤖 Claude is thinking...'));

        const response = await axios.post(API_URL, {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            messages: conversation,
            stream: true,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            responseType: 'stream',
        });

        return new Promise((resolve, reject) => {
            let fullText = '';
            let currentLine = '';
            let insideCodeBlock = false;
            let codeBlockBuffer = '';
            let codeBlockLanguage = '';

            console.log(chalk.green('\nClaude:'));

            response.data.on('data', (chunk) => {
                const newText = parseChunk(chunk);
                fullText += newText;

                for (const char of newText) {
                    if (char === '\n') {
                        if (currentLine.trim().startsWith('```')) {
                            if (!insideCodeBlock) {
                                insideCodeBlock = true;
                                codeBlockLanguage = currentLine.trim().slice(3);
                                codeBlockBuffer = '';
                            } else {
                                const formattedCode = formatCodeBlock(codeBlockBuffer, codeBlockLanguage);
                                process.stdout.write(formattedCode + '\n');
                                insideCodeBlock = false;
                                codeBlockBuffer = '';
                                codeBlockLanguage = '';
                            }
                        } else if (insideCodeBlock) {
                            codeBlockBuffer += currentLine + '\n';
                        } else {
                            process.stdout.write(formatNonCodeText(currentLine) + '\n');
                        }
                        currentLine = '';
                    } else {
                        currentLine += char;
                    }
                }
            });

            response.data.on('end', () => {
                if (currentLine) {
                    if (insideCodeBlock) {
                        process.stdout.write(currentLine);
                    } else {
                        process.stdout.write(formatNonCodeText(currentLine));
                    }
                }
                conversation.push({ role: 'assistant', content: fullText });
                console.log();
                resolve();
            });

            response.data.on('error', (e) => {
                console.error('Stream error:', e);
                reject(e);
            });
        });
    } catch (error) {
        console.log(chalk.red('❌ Error sending message:'));

        if (error.response) {
            console.log(chalk.red(`Status: ${error.response.status}`));
            console.log(chalk.red(`Error: ${error.response.data.error?.message || 'Unknown API error'}`));
        } else if (error.request) {
            console.log(chalk.red('Network error - check your internet connection'));
        } else {
            console.log(chalk.red(`Error: ${error.message}`));
        }
    }
}

function getMultiLineInput() {
    return new Promise((resolve) => {
        const lines = [];

        function readLine() {
            rl.question('>>> ', (line) => {
                if (line === '.') {
                    resolve(lines.join('\n'));
                } else if (line === '\\.') {
                    lines.push('.');
                    readLine();
                } else {
                    lines.push(line);
                    readLine();
                }
            });
        }

        readLine();
    });
}

function startChat() {
    console.log(chalk.yellow('🎉 Welcome to Claude CLI!'));
    console.log(chalk.gray('Type "quit" or "exit" to end the conversation.'));
    console.log(chalk.gray('Hit "enter" on an empty line to begin multi-line input.'));
    console.log(chalk.gray('^D to exit the program.\n'));

    function promptUser() {
        rl.question(chalk.blue('You: '), async (input) => {
            let trimmedInput = input.trim();

            switch (trimmedInput.toLowerCase()) {
                case 'quit':
                case 'exit':
                    rl.close();
                    return;
                case 'archive':
                    if (conversation.length === 0) {
                        console.log(chalk.yellow('No conversation to archive yet.'));
                        promptUser();
                        return;
                    }
                    const archived = archiveHistory(conversation);
                    if (!archived) {
                        promptUser();
                        return;
                    }
                    const summary = await getSummary(conversation);
                    if (summary) {
                        conversation.length = 0;
                        conversation.push({ role: 'assistant', content: `**Conversation summary:**\n\n${summary}` });
                        saveHistory(conversation);
                        console.log(chalk.green('✅ Conversation archived and summarized!'));
                    } else {
                        console.log(chalk.red('Failed to generate summary. History archived but not cleared.'));
                    }

                    promptUser();
                    return;
                case '':
                    trimmedInput = await getMultiLineInput();
                default:
                    await sendMessageToClaude(trimmedInput);
                    printUsage(currentUsage);
                    promptUser();
            }
        });
    }

    promptUser();
}

startChat();

